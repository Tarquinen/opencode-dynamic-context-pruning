import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"

const root = mkdtempSync(join(tmpdir(), "dcp-size-guard-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { Logger } = await import("../lib/logger")
const { createSessionState } = await import("../lib/state")
const { assignMessageRefs } = await import("../lib/message-ids")
const { createCompressRangeTool } = await import("../lib/compress/range")
const { createCompressMessageTool } = await import("../lib/compress/message")
const { assertCompressionShrinksContext, selectionTokenCost } =
    await import("../lib/compress/state")
const { PromptStore } = await import("../lib/prompts/store")

const logger = new Logger(false)

function config(mode: "range" | "message"): PluginConfig {
    return {
        compress: {
            mode,
            permission: "allow",
            protectedTools: [],
            protectUserMessages: false,
            protectTags: false,
        },
        manualMode: { enabled: false, automaticStrategies: true },
        experimental: { allowSubAgents: false },
        turnProtection: { enabled: false, turns: 4 },
        strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
        pruneNotification: "off",
        protectedFilePatterns: [],
    } as unknown as PluginConfig
}

function messages(sessionID: string, bodies: string[]): WithParts[] {
    return bodies.map((body, index) => ({
        info: {
            id: `msg_${index + 1}`,
            role: index % 2 === 0 ? "user" : "assistant",
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created: index + 1 },
        },
        parts: [{ type: "text", text: body }],
    })) as WithParts[]
}

function toolFixture(mode: "range" | "message", bodies: string[]) {
    const sessionID = `ses_guard_${mode}_${Date.now()}`
    const raw = messages(sessionID, bodies)
    const state = createSessionState()
    const settings = config(mode)
    const client = {
        session: {
            messages: async () => ({ data: structuredClone(raw) }),
            get: async () => ({ data: { parentID: null } }),
        },
    }
    const prompts = new PromptStore(logger, root, false, "xml")
    state.sessionId = sessionID
    assignMessageRefs(state, raw)
    const ctx = { client, state, config: settings, logger, prompts } as any
    const tool = mode === "range" ? createCompressRangeTool(ctx) : createCompressMessageTool(ctx)
    const run = {
        sessionID,
        messageID: "msg_compress",
        ask: async () => {},
        metadata() {},
    } as any
    return { state, raw, tool, run, settings }
}

// Varied text, not one repeated character: a run of "x" tokenizes to ~1.2k
// tokens, which would sit under the guard floor and make the test vacuous.
const huge = "alpha beta gamma delta epsilon zeta eta theta ".repeat(700)

test("a range whose summary is not smaller than its content is refused", async () => {
    const { tool, run, state } = toolFixture("range", ["short question", huge, "and more"])

    let message = ""
    try {
        await tool.execute(
            {
                topic: "No gain",
                content: [
                    {
                        startId: "m0001",
                        endId: "m0003",
                        summary: "A summary that is itself enormous. ".repeat(3000),
                    },
                ],
            },
            run,
        )
        assert.fail("expected the compression to be refused")
    } catch (error) {
        message = String((error as Error).message)
    }

    assert.match(message, /Refusing to compress/)
    assert.match(message, /has to shrink the context/)
    // The refusal must not have created a block.
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.prune.messages.activeBlockIds.size, 0)
})

test("a range whose summary is meaningfully smaller is applied", async () => {
    const { tool, run, state } = toolFixture("range", [huge, huge, huge, huge, huge, huge])

    const result = await tool.execute(
        { topic: "Real gain", content: [{ startId: "m0001", endId: "m0006", summary: "short" }] },
        run,
    )

    assert.match(String(result), /Compressed \d+ messages/)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("message mode applies the same guard", async () => {
    const { tool, run, state } = toolFixture("message", ["q", huge, "a"])

    let message = ""
    try {
        await tool.execute(
            {
                topic: "No gain",
                content: [
                    {
                        messageId: "m0002",
                        topic: "No gain",
                        summary: "A summary that is itself enormous. ".repeat(3000),
                    },
                ],
            },
            run,
        )
        assert.fail("expected the compression to be refused")
    } catch (error) {
        message = String((error as Error).message)
    }

    assert.match(message, /Refusing to compress m0002/)
    assert.equal(state.prune.messages.blocksById.size, 0)
})

// The block summaries a new range absorbs are part of its cost. Counting only
// the raw messages is what let the summary grow monotonically across repeated
// compressions (#573).
test("absorbed block summaries count towards the range cost", () => {
    const selection = {
        messageTokenById: new Map([["msg_1", 1_000]]),
        requiredBlockIds: [1],
    }
    const messagesState = {
        blocksById: new Map([
            [1, { summaryTokens: 40_000 }],
            [2, { summaryTokens: 999_999 }],
        ]),
    }

    assert.equal(selectionTokenCost(selection as any, messagesState as any), 41_000)
})

test("the guard fires only when there is no gain", () => {
    // 9_999 summary against 10_000 input: a real (if small) gain.
    assert.doesNotThrow(() => assertCompressionShrinksContext(9_999, 10_000, "m0001..m0002"))
    // Equal: no gain at all.
    assert.throws(() => assertCompressionShrinksContext(10_000, 10_000, "m0001..m0002"), /Refusing/)
    // Worse than the original.
    assert.throws(() => assertCompressionShrinksContext(12_000, 10_000, "m0001..m0002"), /Refusing/)
    // Unknown input size: do not block.
    assert.doesNotThrow(() => assertCompressionShrinksContext(10_000, 0, "m0001..m0002"))
})

test("the guard names the boundary using the session id format", () => {
    assert.throws(
        () => assertCompressionShrinksContext(5000, 4000, "m0001..m0002", "compact"),
        /m0001\.\.m0002/,
    )
    assert.throws(() => assertCompressionShrinksContext(5000, 4000, "4..6", "compact"), /@4\.\.6@/)
})

// Compressing a few short messages into a slightly longer summary is a normal,
// deliberate choice. The guard exists to stop runaway growth, not to police
// micro-compressions, and tokenizer noise on tiny texts is not a reliable
// signal either.
test("the guard leaves small ranges alone", async () => {
    const { tool, run, state } = toolFixture("range", ["q1", "a1", "q2", "a2"])

    const result = await tool.execute(
        { topic: "Small", content: [{ startId: "m0001", endId: "m0004", summary: "S" }] },
        run,
    )

    assert.match(String(result), /Compressed \d+ messages/)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.doesNotThrow(() => assertCompressionShrinksContext(500, 100, "m0001..m0002"))
})
