import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"

const root = mkdtempSync(join(tmpdir(), "dcp-compaction-stats-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { createSessionState } = await import("../lib/state")
const { resetOnCompaction } = await import("../lib/state/utils")
const { analyzeContextTokens } = await import("../lib/commands/context")

function assistant(sessionID: string, id: string, created: number, tokens: any): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created },
            tokens,
        },
        parts: [{ id: `prt_${id}`, messageID: id, sessionID, type: "text", text: "ok" }],
    } as WithParts
}

function user(sessionID: string, id: string, created: number, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created },
        },
        parts: [{ id: `prt_${id}`, messageID: id, sessionID, type: "text", text }],
    } as WithParts
}

// After opencode compacts, the surviving messages are what the model still
// sees. Every number in the /dcp context panel has to describe that set.
test("context breakdown ignores messages that opencode already compacted", () => {
    const sessionID = `ses_stats_${Date.now()}`
    const state = createSessionState()

    const messages = [
        // Pre-compaction history, still in the array but no longer in context.
        assistant(sessionID, "msg_old_assistant", 1, {
            input: 900_000,
            output: 5_000,
            reasoning: 0,
            cache: { read: 0, write: 0 },
        }),
        user(sessionID, "msg_old_user", 2, "a very old question that was compacted away"),
        // opencode compaction summary, which is the new first input-bearing turn.
        assistant(sessionID, "msg_summary", 3, {
            input: 12_000,
            output: 400,
            reasoning: 0,
            cache: { read: 0, write: 0 },
        }),
        user(sessionID, "msg_new_user", 4, "carry on"),
        assistant(sessionID, "msg_new_assistant", 5, {
            input: 3_000,
            output: 600,
            reasoning: 100,
            cache: { read: 40_000, write: 0 },
        }),
    ]

    state.lastCompaction = 3

    const breakdown = analyzeContextTokens(state, messages)

    // The stale 905k turn must not become the denominator or the system prompt.
    assert.equal(
        breakdown.total,
        3_000 + 600 + 100 + 40_000,
        "total came from a compacted assistant message",
    )
    assert.ok(
        breakdown.system <= 12_000,
        `system prompt was inflated to ${breakdown.system} by a compacted message`,
    )
    assert.doesNotMatch(String(breakdown.user), /NaN/)
    assert.ok(breakdown.assistant >= 0, "residual went negative")
})

test("compaction clears the prune token counters it invalidates", () => {
    const state = createSessionState()
    state.stats.pruneTokenCounter = 4_321
    state.stats.totalPruneTokens = 15_000
    state.systemPromptTokens = 8_000
    state.compressionTiming.startsByCallId.set("msg_1:call_1", 1234)
    state.compressionTiming.pendingByCallId.set("msg_1:call_1", {
        messageId: "msg_1",
        callId: "call_1",
        durationMs: 4_200,
    })
    state.toolParameters.set("call_1", { name: "bash" } as any)

    resetOnCompaction(state)

    assert.equal(state.stats.totalPruneTokens, 0)
    assert.equal(state.stats.pruneTokenCounter, 0)
    assert.equal(state.systemPromptTokens, undefined)
    assert.equal(state.compressionTiming.startsByCallId.size, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
    assert.equal(state.toolParameters.size, 0)
})

test("the panel no longer reports pruned tokens it also reports as absent", () => {
    const sessionID = `ses_stats_panel_${Date.now()}`
    const state = createSessionState()
    state.stats.totalPruneTokens = 15_000
    state.lastCompaction = 2

    const messages = [
        assistant(sessionID, "msg_summary", 2, {
            input: 10_000,
            output: 300,
            reasoning: 0,
            cache: { read: 5_000, write: 0 },
        }),
        user(sessionID, "msg_new", 3, "next"),
    ]

    const before = analyzeContextTokens(state, messages)
    assert.ok(before.prunedTokens > 0)

    resetOnCompaction(state)

    const after = analyzeContextTokens(state, messages)
    assert.equal(after.prunedTokens, 0)
    assert.equal(after.prunedToolCount, 0)
    assert.equal(after.prunedMessageCount, 0)
})
