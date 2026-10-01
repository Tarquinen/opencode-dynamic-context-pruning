import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"

const root = mkdtempSync(join(tmpdir(), "dcp-stale-boundary-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { Logger } = await import("../lib/logger")
const { createSessionState } = await import("../lib/state")
const { assignMessageRefs } = await import("../lib/message-ids")
const { resetOnCompaction } = await import("../lib/state/utils")
const { buildSearchContext, resolveBoundaryIds } = await import("../lib/compress/search")
const { createCompressRangeTool } = await import("../lib/compress/range")
const { PromptStore } = await import("../lib/prompts/store")

const logger = new Logger(false)

function config(): any {
    return {
        compress: {
            mode: "range",
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
    }
}

function messages(sessionID: string, count: number): WithParts[] {
    return Array.from({ length: count }, (_, index) => ({
        info: {
            id: `msg_${index + 1}`,
            role: index % 2 === 0 ? "user" : "assistant",
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created: index + 1 },
        },
        parts: [{ type: "text", text: `body ${index}` }],
    })) as WithParts[]
}

test("a boundary ID orphaned by compaction explains why it is gone", async () => {
    const sessionID = `ses_stale_${Date.now()}`
    const state = createSessionState()
    const settings = config()
    const prompts = new PromptStore(logger, root, false, "xml")

    const beforeCompaction = messages(sessionID, 20)
    assignMessageRefs(state, beforeCompaction)
    const staleRef = state.messageIds.byRawId.get("msg_18")!
    assert.equal(staleRef, "m0018")

    // opencode compacts: the old turns are gone and DCP renumbers the survivors.
    const afterCompaction = messages(sessionID, 4)
    resetOnCompaction(state)
    state.lastCompaction = 2
    assignMessageRefs(state, afterCompaction)

    const searchContext = buildSearchContext(state, afterCompaction)
    const client = {
        session: {
            messages: async () => ({ data: afterCompaction }),
            get: async () => ({ data: { parentID: null } }),
        },
    }
    const tool = createCompressRangeTool({
        client,
        state,
        config: settings,
        logger,
        prompts,
    } as any)

    let message = ""
    try {
        await tool.execute(
            {
                topic: "Stale",
                content: [{ startId: staleRef, endId: staleRef, summary: "x" }],
            },
            {
                ask: async () => {},
                metadata() {},
                sessionID,
                messageID: "msg_compress",
            } as any,
        )
        assert.fail("expected the stale boundary to be rejected")
    } catch (error) {
        message = String((error as Error).message)
    }

    assert.match(message, /not available in the current conversation context/)
    assert.match(
        message,
        /before opencode compacted this conversation/,
        "the error still blames the caller for a stale ID",
    )
    assert.match(message, /renumbers IDs/)

    // A ref that is genuinely in context must keep working.
    const live = state.messageIds.byRawId.get("msg_3")!
    const resolved = resolveBoundaryIds(
        buildSearchContext(state, afterCompaction),
        state,
        live,
        live,
    )
    assert.equal(resolved.startReference.messageId, "msg_3")
})
