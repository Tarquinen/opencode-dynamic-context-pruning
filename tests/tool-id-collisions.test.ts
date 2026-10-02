import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-tool-ids-"))
const previousDataHome = process.env.XDG_DATA_HOME
process.env.XDG_DATA_HOME = dataHome
const { createSessionState, syncToolCache, saveSessionState, ensureSessionInitialized } =
    await import("../lib/state")
const { buildToolIdList } = await import("../lib/messages/utils")
const { deduplicate } = await import("../lib/strategies/deduplication")
const { purgeErrors } = await import("../lib/strategies/purge-errors")
const { prune } = await import("../lib/messages/prune")
const { injectExtendedSubAgentResults } = await import("../lib/messages/inject/subagent-results")
const { appendProtectedTools } = await import("../lib/compress/protected-content")
const { buildSearchContext, resolveSelection } = await import("../lib/compress/search")
const { handleSweepCommand } = await import("../lib/commands/sweep")
const { project } = await import("../lib/v2/messages")
const logger = { info() {}, warn() {}, error() {}, debug() {} } as any
const config = {
    manualMode: { enabled: false, automaticStrategies: true },
    turnProtection: { enabled: false, turns: 1 },
    strategies: {
        deduplication: { enabled: true, protectedTools: [] },
        purgeErrors: { enabled: true, turns: 1, protectedTools: [] },
    },
    commands: { enabled: true, protectedTools: [] },
    protectedFilePatterns: [],
    compress: { mode: "range" },
} as PluginConfig

after(() => {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    rmSync(dataHome, { recursive: true, force: true })
})

function toolMessage(id: string, callID: string, path = id): WithParts {
    return {
        info: { id, sessionID: "ses_collisions", role: "assistant", time: { created: 2 } },
        parts: [
            { type: "step-start", id: `step_${id}` },
            {
                type: "tool",
                id: `part_${id}`,
                messageID: id,
                sessionID: "ses_collisions",
                tool: "read",
                callID,
                state: {
                    status: "completed",
                    input: { filePath: path },
                    output: `contents:${path}`,
                    metadata: {},
                    time: { start: 1, end: 2 },
                },
            },
        ],
    } as WithParts
}
const tools = (messages: WithParts[]) =>
    messages.flatMap((m) => m.parts.filter((p) => p.type === "tool"))
const outputs = (messages: WithParts[]) =>
    tools(messages).map((p) => (p.state.status === "completed" ? p.state.output : undefined))
function run(messages: WithParts[], state = createSessionState(), settings = config) {
    syncToolCache(state, settings, logger, messages)
    buildToolIdList(state, messages)
    deduplicate(state, logger, settings, messages)
    purgeErrors(state, logger, settings, messages)
    prune(state, logger, settings, messages)
    return state
}

// #615: a reused provider ID cannot safely address one tool occurrence.
for (const sameInput of [false, true]) {
    test(`reused IDs retain both results with ${sameInput ? "identical" : "different"} inputs`, () => {
        const messages = [
            toolMessage("old", "read:0", "alpha"),
            toolMessage("new", "read:0", sameInput ? "alpha" : "beta"),
        ]
        const expected = outputs(messages)
        const state = run(messages)
        assert.deepEqual(outputs(messages), expected)
        assert.equal(state.prune.tools.size, 0)
        assert.equal(state.stats.totalPruneTokens, 0)
    })
}

test("two parts in one message with the same ID are retained", () => {
    const message = toolMessage("old", "read:0", "alpha")
    message.parts.push(
        ...toolMessage("new", "read:0", "beta").parts.filter((p) => p.type === "tool"),
    )
    const expected = outputs([message])
    run([message])
    assert.deepEqual(outputs([message]), expected)
})

test("unique IDs still remove only the older repeated read", () => {
    const messages = [toolMessage("old", "first", "alpha"), toolMessage("new", "second", "alpha")]
    const state = run(messages)
    assert.deepEqual([...state.prune.tools.keys()], ["first"])
    assert.match(String(outputs(messages)[0]), /Output removed/)
    assert.equal(outputs(messages)[1], "contents:alpha")
})

test("unique IDs with different inputs remain independent", () => {
    const messages = [toolMessage("old", "first"), toolMessage("new", "second")]
    const expected = outputs(messages)
    run(messages)
    assert.deepEqual(outputs(messages), expected)
})

test("a collision introduced after caching clears the old metadata and prune entry", () => {
    const state = createSessionState()
    const old = toolMessage("old", "read:0")
    syncToolCache(state, config, logger, [old])
    state.prune.tools.set("read:0", 100)
    const messages = [old, toolMessage("new", "read:0")]
    const expected = outputs(messages)
    run(messages, state)
    assert.deepEqual(outputs(messages), expected)
    assert.equal(state.toolParameters.has("read:0"), false)
    assert.equal(state.prune.tools.has("read:0"), false)
})

test("compacted occurrences still make a retained call ID ambiguous", () => {
    const state = createSessionState()
    state.lastCompaction = 2
    const messages = [toolMessage("old", "read:0"), toolMessage("new", "read:0")]
    messages[0]!.info.time.created = 1
    state.prune.tools.set("read:0", 100)
    run(messages, state)
    assert.equal(outputs(messages)[1], "contents:new")
})

test("errored calls with reused IDs retain their separate inputs", () => {
    const state = createSessionState()
    state.currentTurn = 10
    const messages = [toolMessage("old", "read:0"), toolMessage("new", "read:0")]
    for (const part of tools(messages)) {
        part.state = {
            status: "error",
            input: part.state.input,
            error: "not found",
            time: { start: 1, end: 2 },
        }
    }
    const expected = structuredClone(messages)
    run(messages, state)
    assert.deepEqual(messages, expected)
})

test("pruning restored legacy state never removes both colliding results", async () => {
    const state = createSessionState()
    state.sessionId = "ses_collisions"
    state.prune.tools.set("read:0", 100)
    await saveSessionState(state, logger)
    const messages = [toolMessage("old", "read:0"), toolMessage("new", "read:0")]
    const user = {
        info: { id: "user", sessionID: "ses_collisions", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "Continue" }],
    } as WithParts
    const restored = createSessionState()
    await ensureSessionInitialized(
        { session: { get: async () => ({ data: {} }) } },
        restored,
        "ses_collisions",
        logger,
        [user, ...messages],
        false,
    )
    assert.equal(restored.prune.tools.has("read:0"), true, "legacy file actually loaded")
    // The final pruning boundary must also be safe before a cache refresh.
    prune(restored, logger, config, messages)
    assert.deepEqual(outputs(messages), ["contents:old", "contents:new"])
})

for (const args of [[], ["1"]]) {
    test(`manual sweep retains ambiguous IDs (${args.length ? "last-n" : "since-user"})`, async () => {
        const state = createSessionState()
        const messages = [
            toolMessage("unique", "unique"),
            toolMessage("old", "read:0"),
            {
                info: {
                    id: "user",
                    sessionID: "ses_collisions",
                    role: "user",
                    agent: "build",
                    model: { providerID: "local", modelID: "fixed" },
                    time: { created: 1 },
                },
                parts: [{ type: "text", text: "Continue" }],
            } as WithParts,
            toolMessage("new", "read:0"),
        ]
        await handleSweepCommand({
            client: { session: { prompt: async () => ({}) } },
            state,
            config,
            logger,
            sessionId: "ses_collisions",
            messages,
            args,
            workingDirectory: dataHome,
        })
        assert.equal(state.prune.tools.size, 0)
        assert.equal(state.stats.totalPruneTokens, 0)
        assert.deepEqual(outputs(messages), ["contents:unique", "contents:old", "contents:new"])
    })
}

function taskMessages() {
    const messages = [toolMessage("old", "task:0"), toolMessage("new", "task:0")]
    for (const [i, part] of tools(messages).entries()) {
        part.tool = "task"
        if (part.state.status === "completed") {
            part.state.metadata = { sessionId: `child_${i}` }
            part.state.output = "<task_result>placeholder</task_result>"
        }
    }
    return messages
}
const childClient = {
    session: {
        messages: async ({ path }: any) => ({
            data: [
                {
                    info: {
                        id: path.id,
                        sessionID: path.id,
                        role: "assistant",
                        time: { created: 1 },
                    },
                    parts: [{ type: "text", text: `result:${path.id}` }],
                },
            ],
        }),
    },
}

test("subagent caches keep reused IDs separate across messages", async () => {
    const messages = taskMessages()
    await injectExtendedSubAgentResults(childClient, createSessionState(), logger, messages, true)
    assert.deepEqual(outputs(messages), [
        "<task_result>result:child_0</task_result>",
        "<task_result>result:child_1</task_result>",
    ])
})

test("protected summaries keep both subagents' actual results", async () => {
    const messages = taskMessages()
    const state = createSessionState()
    const context = buildSearchContext(state, messages)
    const selection = resolveSelection(
        context,
        { kind: "message", rawIndex: 0, messageId: "old" },
        { kind: "message", rawIndex: 1, messageId: "new" },
    )
    const summary = await appendProtectedTools(
        childClient,
        state,
        true,
        "summary",
        selection,
        context,
        ["task"],
    )
    assert.match(summary, /result:child_0/)
    assert.match(summary, /result:child_1/)
})

test("V2 projection pairs each reused ID with the following turn's result", () => {
    const native = [
        {
            id: "old",
            role: "assistant",
            content: [{ type: "tool-call", id: "read:0", name: "read", input: { path: "alpha" } }],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "read:0",
                    name: "read",
                    result: { type: "text", value: "alpha" },
                },
            ],
        },
        {
            id: "new",
            role: "assistant",
            content: [{ type: "tool-call", id: "read:0", name: "read", input: { path: "beta" } }],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "read:0",
                    name: "read",
                    result: { type: "text", value: "beta" },
                },
            ],
        },
    ] as any
    const entries = ["old", "new"].map((id) => ({
        id,
        type: "assistant",
        time: { created: 1 },
        model: {},
        content: [],
    })) as any
    const view = project(native, entries, {
        id: "ses_collisions",
        model: {},
        agent: "build",
    } as any)
    assert.deepEqual(outputs(view.messages), ["alpha", "beta"])
    run(view.messages)
    assert.deepEqual(view.restore(), native)
    // Compressing the old message must remove only its paired result.
    const state = createSessionState()
    state.prune.messages.byMessageId.set("old", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    prune(state, logger, config, view.messages)
    assert.deepEqual(view.restore(), native.slice(2))
})
