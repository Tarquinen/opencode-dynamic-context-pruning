import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, syncToolCache, type WithParts } from "../lib/state"
import { deduplicate } from "../lib/strategies/deduplication"
import { purgeErrors } from "../lib/strategies/purge-errors"
import { appendProtectedTools } from "../lib/compress/protected-content"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import { isToolProtected } from "../lib/protected-patterns"
import { getSubAgentId, mergeSubagentResult } from "../lib/subagents/subagent-results"

const logger = new Logger(false)
const config = {
    manualMode: { automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    protectedFilePatterns: ["**/protected.txt"],
    strategies: {
        deduplication: { enabled: true, protectedTools: [] },
        purgeErrors: { enabled: true, turns: 1, protectedTools: [] },
    },
} as PluginConfig

test("Code Mode protections survive caching, strategy selection, and compression", async () => {
    const state = createSessionState()
    state.currentTurn = 10
    const messages = ["first", "second", "failed"].map((id) => ({
        info: { id, role: "assistant", time: { created: 1 } },
        parts: [
            {
                type: "tool",
                tool: "execute",
                callID: id,
                state: {
                    status: id === "failed" ? "error" : "completed",
                    input: { code: "return await tools.read({path: 'protected.txt'})" },
                    output: "PROTECTED_OUTPUT and another tool's output",
                    error: "Failed operation",
                    metadata: {
                        toolCalls: [
                            {
                                tool: "read",
                                input: { path: "/project/protected.txt" },
                                status: "completed",
                            },
                        ],
                    },
                },
            },
        ],
    })) as unknown as WithParts[]
    syncToolCache(state, config, logger, messages)
    state.toolIdList = ["first", "second", "failed"]
    deduplicate(state, logger, config, messages)
    purgeErrors(state, logger, config, messages)
    assert.equal(state.prune.tools.size, 0)

    const context = buildSearchContext(state, messages)
    const boundary = { kind: "message" as const, rawIndex: 0, messageId: "first" }
    const selection = resolveSelection(context, boundary, boundary)
    const summary = await appendProtectedTools(
        {},
        state,
        false,
        "SUMMARY",
        selection,
        context,
        [],
        config.protectedFilePatterns,
    )
    assert.match(summary.summaryText, /PROTECTED_OUTPUT and another tool's output/)

    const unprotected = { ...config, protectedFilePatterns: [] }
    deduplicate(state, logger, unprotected, messages)
    purgeErrors(state, logger, unprotected, messages)
    assert.deepEqual([...state.prune.tools.keys()], ["first", "second", "failed"])
})

test("Code Mode honors protected tool names as well as file paths", () => {
    const metadata = { toolCalls: [{ tool: "skill", input: { name: "example" } }] }
    assert.equal(isToolProtected("execute", {}, ["skill"], [], metadata), true)
    assert.equal(isToolProtected("execute", {}, [], [], metadata), false)
    assert.equal(
        isToolProtected(
            "read",
            { path: "/project/protected.txt" },
            [],
            config.protectedFilePatterns,
        ),
        true,
    )
})

test("subagent expansion preserves both host wrapper formats", () => {
    for (const [metadata, original, expected] of [
        [
            { sessionId: "ses_child" },
            "<task_result>old</task_result>",
            "<task_result>new</task_result>",
        ],
        [
            { sessionID: "ses_child" },
            '<subagent sessionID="ses_child" state="completed">old</subagent>',
            '<subagent sessionID="ses_child" state="completed">new</subagent>',
        ],
    ] as const) {
        assert.equal(getSubAgentId({ state: { metadata } }), "ses_child")
        assert.equal(mergeSubagentResult(original, "new"), expected)
    }
})
