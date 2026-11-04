import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"
import {
    buildContextSnapshot,
    collectUncoveredToolOutputs,
    computeCoverage,
    estimateMessageSetStats,
    formatContextSnapshot,
    getReportedTokens,
} from "../lib/context/accounting"

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

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    tool: string,
    input: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        callID,
        tool,
        state: {
            status: "completed" as const,
            input: { text: input },
            output,
        },
    }
}

function buildMessages(): WithParts[] {
    const sessionID = "ses_accounting"
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "p1", "hello world")],
        },
        {
            info: {
                id: "msg-asst-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: {
                    input: 100,
                    output: 50,
                    reasoning: 10,
                    cache: { read: 40, write: 0 },
                },
            } as WithParts["info"],
            parts: [
                textPart("msg-asst-1", sessionID, "p2", "replying"),
                toolPart(
                    "msg-asst-1",
                    sessionID,
                    "call-1",
                    "read",
                    '{"filePath":"a.ts"}',
                    "A".repeat(400),
                ),
            ],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-user-2", sessionID, "p3", "more")],
        },
    ]
}

test("getReportedTokens reads the newest assistant message token fields", () => {
    const messages = buildMessages()
    const reported = getReportedTokens(messages)
    assert.equal(reported.input, 100)
    assert.equal(reported.output, 50)
    assert.equal(reported.reasoning, 10)
    assert.equal(reported.cacheRead, 40)
    assert.equal(reported.total, 200)
})

test("estimateMessageSetStats counts text and tool content tokens", () => {
    const messages = buildMessages()
    const stats = estimateMessageSetStats(messages)
    assert.equal(stats.count, 3)
    assert.ok(stats.tokens > 0)
})

test("computeCoverage separates covered from uncovered message tokens", () => {
    const messages = buildMessages()
    const state = createSessionState()
    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 10,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const coverage = computeCoverage(state, messages)
    assert.ok(coverage.coveredTokens > 0)
    assert.ok(coverage.uncoveredTokens > 0)
})

test("collectUncoveredToolOutputs aggregates per-tool tokens for un-compacted messages", () => {
    const messages = buildMessages()
    const state = createSessionState()
    const tools = collectUncoveredToolOutputs(state, messages)
    assert.ok(tools.some((entry) => entry.tool === "read" && entry.tokens > 0))
})

test("buildContextSnapshot computes thresholds and over-limit flags", () => {
    const messages = buildMessages()
    const state = createSessionState()
    const rawStats = estimateMessageSetStats(messages)
    const coverage = computeCoverage(state, messages)
    const uncoveredTools = collectUncoveredToolOutputs(state, messages)

    const snapshot = buildContextSnapshot(
        state,
        buildConfig(150, 100),
        undefined,
        undefined,
        rawStats,
        rawStats,
        coverage,
        uncoveredTools,
        messages,
    )

    assert.equal(snapshot.rawMessageCount, 3)
    assert.equal(snapshot.reported.total, 200)
    assert.equal(snapshot.maxContextLimit, 150)
    assert.equal(snapshot.effectiveMaxContextLimit, 150)
    assert.equal(snapshot.overMaxLimit, true)
    assert.equal(snapshot.overMinLimit, true)
    assert.equal(snapshot.justCompressed, false)
    assert.equal(snapshot.lastDcpCompression, 0)
    assert.equal(snapshot.reportedStale, false)
    assert.equal(snapshot.estimatedTransformedTokens, snapshot.rawEstimatedTokens)
})

test("formatContextSnapshot renders a human readable block", () => {
    const messages = buildMessages()
    const state = createSessionState()
    const rawStats = estimateMessageSetStats(messages)
    const snapshot = buildContextSnapshot(
        state,
        buildConfig(1000, 100),
        undefined,
        undefined,
        rawStats,
        rawStats,
        computeCoverage(state, messages),
        collectUncoveredToolOutputs(state, messages),
        messages,
    )
    const text = formatContextSnapshot(snapshot)
    assert.ok(text.includes("Provider reported"))
    assert.ok(text.includes("Raw messages"))
    assert.ok(text.includes("Blocks"))
    assert.ok(text.includes("Over max limit"))
})
