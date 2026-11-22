import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { wrapCompressedSummary } from "../lib/compress/state"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state"
import { getCurrentTokenUsage } from "../lib/token-utils"

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

test("isContextOverLimits accounts for context growth after latest assistant report", () => {
    const sessionID = "ses_context_growth_after_report"
    const reportedTotal = 1000 + 100 + 50 + 25
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-assistant-reported",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
                tokens: {
                    input: 1000,
                    output: 100,
                    reasoning: 50,
                    cache: {
                        read: 25,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-reported", sessionID, "assistant-part", "Done.")],
        },
        {
            info: {
                id: "msg-user-large-followup",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-large-followup",
                    sessionID,
                    "user-large-part",
                    repeatedWord("payload", 5000),
                ),
            ],
        },
    ]
    const state = createSessionState()

    assert.ok(getCurrentTokenUsage(state, messages) > reportedTotal)

    const overLimit = isContextOverLimits(
        buildConfig(reportedTotal + 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overLimit.overMaxLimit, true)
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
