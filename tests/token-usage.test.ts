import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits, isPollOnlyTurn } from "../lib/messages/inject/utils"
import { wrapCompressedSummary } from "../lib/compress/state"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state"
import { getCurrentTokenUsage, isReportedTokensStaleAfterDcpCompression } from "../lib/token-utils"

function buildConfig(maxContextLimit: number, minContextLimit = 1): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            contextAccounting: false,
            recoverInherited: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit,
            minContextLimit,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            pollCooldown: 3,
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function repeatedWord(word: string, count: number): string {
    return Array.from({ length: count }, () => word).join(" ")
}

function buildCompactedMessages(): WithParts[] {
    const sessionID = "ses_compaction_token_usage"

    return [
        {
            info: {
                id: "msg-user-summary",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-summary",
                    sessionID,
                    "msg-user-summary-part",
                    `[Compressed conversation section]\n${repeatedWord("summary", 120)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
                tokens: {
                    input: 86000,
                    output: 1200,
                    reasoning: 300,
                    cache: {
                        read: 5000,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    `Compaction summary. ${repeatedWord("carry", 180)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    `Continue from here. ${repeatedWord("next", 40)}`,
                ),
            ],
        },
    ]
}

function buildPostCompactionAssistantMessage(): WithParts {
    const sessionID = "ses_compaction_token_usage"

    return {
        info: {
            id: "msg-assistant-post-compaction",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 4 },
            tokens: {
                input: 2400,
                output: 600,
                reasoning: 150,
                cache: {
                    read: 300,
                    write: 0,
                },
            },
        } as WithParts["info"],
        parts: [
            textPart(
                "msg-assistant-post-compaction",
                sessionID,
                "msg-assistant-post-compaction-part",
                `Fresh post-compaction reply. ${repeatedWord("done", 60)}`,
            ),
        ],
    }
}

function createActiveBlock(
    blockId: number,
    summary: string,
    summaryTokens: number,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens,
        mode: "message",
        topic: `Summary ${blockId}`,
        batchTopic: `Summary ${blockId}`,
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: blockId,
        summary,
    }
}

test("getCurrentTokenUsage returns 0 until a fresh assistant follows compaction", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("isContextOverLimits ignores stale summary totals and resumes with fresh reported totals", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    const staleAssistantTotal = 86000 + 1200 + 300 + 5000
    assert.equal(getCurrentTokenUsage(state, messages), 0)

    const underLimit = isContextOverLimits(
        buildConfig(staleAssistantTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underLimit.overMaxLimit, false)
    assert.equal(underLimit.overMinLimit, false)

    messages.push(buildPostCompactionAssistantMessage())
    const freshReportedTotal = 2400 + 600 + 150 + 300

    assert.equal(getCurrentTokenUsage(state, messages), freshReportedTotal)

    const overLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overLimit.overMaxLimit, true)
})

test("isContextOverLimits extends the max threshold by active summary tokens", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300

    const underExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underExtendedLimit.overMaxLimit, false)

    const overExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1001, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overExtendedLimit.overMaxLimit, true)
})

test("isContextOverLimits does not extend the max threshold when summaryBuffer is disabled", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300
    const config = buildConfig(freshReportedTotal - 1, 1)
    config.compress.summaryBuffer = false

    const overLimit = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(overLimit.overMaxLimit, true)
})

function buildPostDcpCompressionMessages(): WithParts[] {
    const sessionID = "ses_dcp_cooldown"
    return [
        {
            info: {
                id: "msg-user-a",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-a", sessionID, "pa1", repeatedWord("large", 500))],
        },
        {
            info: {
                id: "msg-asst-pre-compress",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: {
                    input: 50000,
                    output: 800,
                    reasoning: 200,
                    cache: { read: 3000, write: 0 },
                },
            } as WithParts["info"],
            parts: [textPart("msg-asst-pre-compress", sessionID, "pa2", repeatedWord("done", 100))],
        },
        {
            info: {
                id: "msg-user-after",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 5 },
            } as WithParts["info"],
            parts: [textPart("msg-user-after", sessionID, "pa3", "continue")],
        },
    ]
}

test("isReportedTokensStaleAfterDcpCompression flags totals older than the last DCP compression", () => {
    const messages = buildPostDcpCompressionMessages()
    const state = createSessionState()

    // No DCP compression yet: not stale.
    assert.equal(isReportedTokensStaleAfterDcpCompression(state, messages), false)

    // DCP compressed after the last reported assistant message: stale.
    state.lastDcpCompression = 3
    assert.equal(isReportedTokensStaleAfterDcpCompression(state, messages), true)

    // A fresh assistant message after the compression: not stale.
    messages.push({
        info: {
            id: "msg-asst-fresh",
            role: "assistant",
            sessionID: "ses_dcp_cooldown",
            agent: "assistant",
            time: { created: 6 },
            tokens: {
                input: 2000,
                output: 300,
                reasoning: 0,
                cache: { read: 500, write: 0 },
            },
        } as WithParts["info"],
        parts: [],
    })
    assert.equal(isReportedTokensStaleAfterDcpCompression(state, messages), false)
})

test("isContextOverLimits suppresses emergency max nudge from stale post-DCP totals", () => {
    const messages = buildPostDcpCompressionMessages()
    const state = createSessionState()
    state.lastDcpCompression = 3

    // The stale reported total (54K) exceeds the max limit, but the local
    // estimate of the pruned view does not.
    const staleTotal = 50000 + 800 + 200 + 3000
    const result = isContextOverLimits(
        buildConfig(staleTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(result.reportedStale, true)
    assert.equal(result.overMaxLimit, false)
    assert.equal(result.currentTokens, staleTotal)
    assert.ok(result.estimatedTransformedTokens < staleTotal)
})

test("isContextOverLimits keeps emergency nudge when the estimated transformed view is also over", () => {
    const messages = buildPostDcpCompressionMessages()
    const state = createSessionState()
    state.lastDcpCompression = 3

    const staleTotal = 50000 + 800 + 200 + 3000
    // max limit below both the stale total AND the estimated transformed view.
    const result = isContextOverLimits(buildConfig(100, 1), state, undefined, undefined, messages)

    assert.equal(result.reportedStale, true)
    assert.equal(result.overMaxLimit, true)
})

test("isContextOverLimits uses reported totals when no DCP compression happened", () => {
    const messages = buildPostDcpCompressionMessages()
    const state = createSessionState()

    const staleTotal = 50000 + 800 + 200 + 3000
    const result = isContextOverLimits(
        buildConfig(staleTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(result.reportedStale, false)
    assert.equal(result.overMaxLimit, true)
})

function buildPollTurnMessages(): WithParts[] {
    const sessionID = "ses_poll"
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "pp1", "start the server")],
        },
        {
            info: {
                id: "msg-asst-poll-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-asst-poll-1", sessionID, "pp2", "checking status"),
                {
                    id: "pp2-tool",
                    messageID: "msg-asst-poll-1",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-poll-1",
                    state: {
                        status: "completed" as const,
                        input: { command: "check" },
                        output: "NOT_DONE",
                    },
                },
            ],
        },
        {
            info: {
                id: "msg-asst-poll-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-asst-poll-2", sessionID, "pp3", "checking status again"),
                {
                    id: "pp3-tool",
                    messageID: "msg-asst-poll-2",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-poll-2",
                    state: {
                        status: "completed" as const,
                        input: { command: "check" },
                        output: "NOT_DONE",
                    },
                },
            ],
        },
        {
            info: {
                id: "msg-asst-poll-3",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 4 },
            } as WithParts["info"],
            parts: [
                textPart("msg-asst-poll-3", sessionID, "pp4", "checking status once more"),
                {
                    id: "pp4-tool",
                    messageID: "msg-asst-poll-3",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-poll-3",
                    state: {
                        status: "completed" as const,
                        input: { command: "check" },
                        output: "NOT_DONE",
                    },
                },
            ],
        },
    ]
}

test("isPollOnlyTurn detects repeated tool-only assistant turns without user input", () => {
    const messages = buildPollTurnMessages()
    const state = createSessionState()

    assert.equal(isPollOnlyTurn(state, messages, 3), true)
    assert.equal(isPollOnlyTurn(state, messages, 4), false)
})

test("isPollOnlyTurn returns false when a fresh user message resets the loop", () => {
    const messages = buildPollTurnMessages()
    messages.push({
        info: {
            id: "msg-user-2",
            role: "user",
            sessionID: "ses_poll",
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 5 },
        } as WithParts["info"],
        parts: [textPart("msg-user-2", "ses_poll", "pp5", "it is still not done?")],
    })

    const state = createSessionState()
    assert.equal(isPollOnlyTurn(state, messages, 3), false)
})

test("isPollOnlyTurn returns false for assistant turns without tool calls", () => {
    const messages = buildPollTurnMessages()
    const state = createSessionState()

    // Strip the tool parts -> assistant turns are plain text, not polling.
    for (const msg of messages) {
        if (msg.info.role === "assistant") {
            msg.parts = msg.parts.filter((part) => part.type !== "tool")
        }
    }

    assert.equal(isPollOnlyTurn(state, messages, 3), false)
})
