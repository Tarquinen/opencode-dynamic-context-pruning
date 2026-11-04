/**
 * DCP Context Accounting Snapshot
 *
 * Computes an explainable picture of where the current request's context stands:
 *   - raw messages (as they exist in the session) vs the transformed view DCP
 *     actually sends to the model,
 *   - compression-block coverage (covered vs uncovered message tokens),
 *   - the largest uncovered tool outputs (the usual "why is context still full"
 *     offenders),
 *   - provider-reported token totals (what the UI shows),
 *   - the effective thresholds used by the nudge logic.
 *
 * The snapshot is computed on every messages transform and surfaced through
 * `/dcp context` so the raw-vs-transformed gap becomes visible instead of
 * guessing from the UI percentage.
 */

import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { countAllMessageTokens, countTokens, extractCompletedToolOutput } from "../token-utils"
import { getActiveSummaryTokenUsage, isMessageCompacted } from "../state/utils"
import { estimateTransformedTokens, resolveContextTokenLimit } from "../messages/inject/utils"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

export interface ReportedTokenReport {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
}

export interface UncoveredToolEntry {
    tool: string
    tokens: number
}

export interface MessageSetStats {
    count: number
    tokens: number
}

export interface CoverageStats {
    coveredTokens: number
    uncoveredTokens: number
}

export interface ContextAccountingSnapshot {
    timestamp: number
    rawMessageCount: number
    rawEstimatedTokens: number
    transformedMessageCount: number
    transformedEstimatedTokens: number
    activeBlockCount: number
    totalBlockCount: number
    activeSummaryTokens: number
    coveredMessageTokens: number
    uncoveredMessageTokens: number
    uncoveredToolCount: number
    largestUncoveredTools: UncoveredToolEntry[]
    reported: ReportedTokenReport
    modelContextLimit: number | undefined
    maxContextLimit: number | undefined
    summaryBufferExtension: number
    effectiveMaxContextLimit: number | undefined
    minContextLimit: number | undefined
    overMaxLimit: boolean
    overMinLimit: boolean
    justCompressed: boolean
    lastDcpCompression: number
    reportedStale: boolean
    estimatedTransformedTokens: number
}

export function getReportedTokens(messages: WithParts[]): ReportedTokenReport {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }
        const info = msg.info as AssistantMessage
        if ((info.tokens?.output || 0) <= 0) {
            continue
        }
        const input = info.tokens?.input || 0
        const output = info.tokens?.output || 0
        const reasoning = info.tokens?.reasoning || 0
        const cacheRead = info.tokens?.cache?.read || 0
        const cacheWrite = info.tokens?.cache?.write || 0
        return {
            input,
            output,
            reasoning,
            cacheRead,
            cacheWrite,
            total: input + output + reasoning + cacheRead + cacheWrite,
        }
    }
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export function estimateMessageSetStats(messages: WithParts[]): MessageSetStats {
    let tokens = 0
    for (const msg of messages) {
        tokens += countAllMessageTokens(msg)
    }
    return { count: messages.length, tokens }
}

export function computeCoverage(state: SessionState, messages: WithParts[]): CoverageStats {
    let covered = 0
    let uncovered = 0
    for (const msg of messages) {
        const entry = state.prune.messages.byMessageId.get(msg.info.id)
        const isCovered = !!entry && entry.activeBlockIds.length > 0
        const tokens = countAllMessageTokens(msg)
        if (isCovered) {
            covered += tokens
        } else {
            uncovered += tokens
        }
    }
    return { coveredTokens: covered, uncoveredTokens: uncovered }
}

export function collectUncoveredToolOutputs(
    state: SessionState,
    messages: WithParts[],
    limit: number = 8,
): UncoveredToolEntry[] {
    const byTool = new Map<string, number>()
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            const output = extractCompletedToolOutput(part)
            if (output === undefined) {
                continue
            }
            const tokens = countTokens(output)
            if (tokens <= 0) {
                continue
            }
            byTool.set(part.tool, (byTool.get(part.tool) || 0) + tokens)
        }
    }
    return [...byTool.entries()]
        .map(([tool, tokens]) => ({ tool, tokens }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, limit)
}

export function buildContextSnapshot(
    state: SessionState,
    config: PluginConfig,
    providerId: string | undefined,
    modelId: string | undefined,
    rawStats: MessageSetStats,
    transformedStats: MessageSetStats,
    coverage: CoverageStats,
    uncoveredTools: UncoveredToolEntry[],
    messages: WithParts[],
): ContextAccountingSnapshot {
    const activeSummaryTokens = getActiveSummaryTokenUsage(state)
    const summaryBufferExtension = config.compress.summaryBuffer ? activeSummaryTokens : 0
    const resolvedMax = resolveContextTokenLimit(config, state, providerId, modelId, "max")
    const effectiveMax =
        resolvedMax === undefined ? undefined : resolvedMax + summaryBufferExtension
    const minLimit = resolveContextTokenLimit(config, state, providerId, modelId, "min")
    const reported = getReportedTokens(messages)
    const currentTokens = reported.total
    const estimatedTransformedTokens = estimateTransformedTokens(state, messages)
    const reportedStale =
        state.lastDcpCompression > 0 &&
        (() => {
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i]
                if (msg.info.role !== "assistant") continue
                const info = msg.info as AssistantMessage
                if ((info.tokens?.output || 0) > 0) {
                    return msg.info.time.created < state.lastDcpCompression
                }
            }
            return false
        })()
    const effectiveMaxTokens = reportedStale ? estimatedTransformedTokens : currentTokens
    const overMaxLimit = effectiveMax === undefined ? false : effectiveMaxTokens > effectiveMax
    const overMinLimit = minLimit === undefined ? true : currentTokens >= minLimit

    let justCompressed = false
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        justCompressed = parts.some(
            (part) =>
                part.type === "tool" &&
                part.tool === "compress" &&
                part.state?.status === "completed",
        )
        break
    }

    return {
        timestamp: Date.now(),
        rawMessageCount: rawStats.count,
        rawEstimatedTokens: rawStats.tokens,
        transformedMessageCount: transformedStats.count,
        transformedEstimatedTokens: transformedStats.tokens,
        activeBlockCount: state.prune.messages.activeBlockIds.size,
        totalBlockCount: state.prune.messages.blocksById.size,
        activeSummaryTokens,
        coveredMessageTokens: coverage.coveredTokens,
        uncoveredMessageTokens: coverage.uncoveredTokens,
        uncoveredToolCount: uncoveredTools.length,
        largestUncoveredTools: uncoveredTools,
        reported,
        modelContextLimit: state.modelContextLimit,
        maxContextLimit: resolvedMax,
        summaryBufferExtension,
        effectiveMaxContextLimit: effectiveMax,
        minContextLimit: minLimit,
        overMaxLimit,
        overMinLimit,
        justCompressed,
        lastDcpCompression: state.lastDcpCompression,
        reportedStale,
        estimatedTransformedTokens,
    }
}

export function formatContextSnapshot(snapshot: ContextAccountingSnapshot): string {
    const lines: string[] = []
    lines.push("DCP Context Accounting Snapshot:")
    lines.push("─".repeat(58))
    lines.push(
        `  Provider reported:  ${snapshot.reported.input} input / ${snapshot.reported.cacheRead} cache.read / ${snapshot.reported.output} output / ${snapshot.reported.reasoning} reasoning`,
    )
    lines.push(`  Provider total:     ${snapshot.reported.total.toLocaleString()} tokens`)
    lines.push(
        `  Raw messages:       ${snapshot.rawMessageCount} (~${snapshot.rawEstimatedTokens.toLocaleString()} tok)`,
    )
    lines.push(
        `  Transformed:        ${snapshot.transformedMessageCount} (~${snapshot.transformedEstimatedTokens.toLocaleString()} tok)`,
    )
    lines.push(`  Estimated sent:     ~${snapshot.estimatedTransformedTokens.toLocaleString()} tok`)
    lines.push(
        `  Blocks:             ${snapshot.activeBlockCount} active / ${snapshot.totalBlockCount} total`,
    )
    lines.push(
        `  Coverage:           ${snapshot.coveredMessageTokens.toLocaleString()} covered / ${snapshot.uncoveredMessageTokens.toLocaleString()} uncovered tok`,
    )
    lines.push(`  Active summary:     ${snapshot.activeSummaryTokens.toLocaleString()} tok`)
    if (snapshot.largestUncoveredTools.length > 0) {
        lines.push("  Largest uncovered tool outputs:")
        for (const entry of snapshot.largestUncoveredTools) {
            lines.push(`    - ${entry.tool}: ${entry.tokens.toLocaleString()} tok`)
        }
    }
    lines.push(`  Model context:      ${snapshot.modelContextLimit?.toLocaleString() ?? "unknown"}`)
    lines.push(
        `  DCP max threshold:  ${snapshot.effectiveMaxContextLimit?.toLocaleString() ?? "unset"} (max ${snapshot.maxContextLimit?.toLocaleString() ?? "unset"} + buffer ${snapshot.summaryBufferExtension.toLocaleString()})`,
    )
    lines.push(`  DCP min threshold:  ${snapshot.minContextLimit?.toLocaleString() ?? "unset"}`)
    lines.push(`  Over max limit:     ${snapshot.overMaxLimit}`)
    lines.push(`  Over min limit:     ${snapshot.overMinLimit}`)
    lines.push(`  Just compressed:    ${snapshot.justCompressed}`)
    lines.push(`  Reported stale:     ${snapshot.reportedStale}`)
    if (snapshot.lastDcpCompression > 0) {
        lines.push(`  Last DCP compress:  ${new Date(snapshot.lastDcpCompression).toISOString()}`)
    }
    return lines.join("\n")
}
