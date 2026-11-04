import type { SessionState, WithParts } from "../../state"
import { formatBlockRef } from "../../message-ids"
import { isIgnoredUserMessage } from "../query"

const SYNTHETIC_SUMMARY_ID_PREFIX = "msg_dcp_summary_"

export interface UncoveredRegion {
    startRef: string
    endRef: string
    startMessageId: string
    endMessageId: string
    messageCount: number
    estimatedTokens: number
}

export interface BlockSummaryEntry {
    blockId: number
    summaryTokens: number
}

export interface ReclaimableMap {
    /** Contiguous runs of raw messages not covered by any active block, biggest first. */
    uncovered: UncoveredRegion[]
    /** Active block summaries, biggest first (merging several reclaims their overlap). */
    blockSummaries: BlockSummaryEntry[]
    /** Rough token weight of everything currently visible to the model. */
    totalVisibleTokens: number
}

/**
 * Build a "cost map" of the current transformed view so the model can see WHERE
 * the reclaimable tokens actually are instead of guessing.
 *
 * DCP is incremental: only ranges that entered a block were replaced by a
 * summary. Everything else is still sent verbatim. This function finds those
 * raw uncovered runs and the active summaries, both ranked by size, so the
 * nudge can point the model at the largest reclaimable content first.
 *
 * Works on both views: the pruned transform view (covered content replaced by
 * synthetic summaries, id prefix `msg_dcp_summary_`) and the raw session view
 * used by the manual /dcp-compress command (covered content still present and
 * marked active in `byMessageId`).
 */
export function findReclaimableRegions(state: SessionState, messages: WithParts[]): ReclaimableMap {
    const uncovered: UncoveredRegion[] = []
    let current: UncoveredRegion | null = null
    let totalVisibleTokens = 0

    for (const message of messages) {
        const tokens = estimateMessageTokens(state, message)
        totalVisibleTokens += tokens

        if (isIgnoredUserMessage(message) || isNativeCompactionSummary(state, message)) {
            continue
        }

        if (isUncoveredMessage(state, message)) {
            const ref = state.messageIds.byRawId.get(message.info.id)
            if (!ref) {
                continue
            }
            if (!current) {
                current = {
                    startRef: ref,
                    endRef: ref,
                    startMessageId: message.info.id,
                    endMessageId: message.info.id,
                    messageCount: 1,
                    estimatedTokens: tokens,
                }
            } else {
                current.endRef = ref
                current.endMessageId = message.info.id
                current.messageCount++
                current.estimatedTokens += tokens
            }
            continue
        }

        // Covered content (synthetic summary or active-covered message) ends the run.
        if (current) {
            uncovered.push(current)
            current = null
        }
    }
    if (current) {
        uncovered.push(current)
    }

    uncovered.sort((a, b) => b.estimatedTokens - a.estimatedTokens)

    const blockSummaries: BlockSummaryEntry[] = []
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || !block.active) {
            continue
        }
        blockSummaries.push({ blockId, summaryTokens: block.summaryTokens })
    }
    blockSummaries.sort((a, b) => b.summaryTokens - a.summaryTokens)

    return { uncovered, blockSummaries, totalVisibleTokens }
}

function isUncoveredMessage(state: SessionState, message: WithParts): boolean {
    if (message.info.id.startsWith(SYNTHETIC_SUMMARY_ID_PREFIX)) {
        return false
    }
    const entry = state.prune.messages.byMessageId.get(message.info.id)
    if (entry && entry.activeBlockIds.length > 0) {
        return false
    }
    return true
}

function isNativeCompactionSummary(state: SessionState, message: WithParts): boolean {
    if (message.info.summary === true) {
        return true
    }
    return (
        typeof message.info.time.created === "number" &&
        message.info.time.created < state.lastCompaction
    )
}

function estimateMessageTokens(state: SessionState, message: WithParts): number {
    const entry = state.prune.messages.byMessageId.get(message.info.id)
    if (entry && entry.tokenCount > 0) {
        return entry.tokenCount
    }
    return Math.round(countMessageCharacters(message) / 4)
}

function countMessageCharacters(message: WithParts): number {
    let chars = 0
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
            chars += part.text.length
        } else if (part.type === "tool") {
            const toolState = part.state
            if (toolState && typeof toolState.input !== "undefined") {
                chars += stringLength(toolState.input)
            }
            if (toolState?.status === "completed" && typeof toolState.output !== "undefined") {
                chars += stringLength(toolState.output)
            } else if (toolState?.status === "error" && toolState.error) {
                chars += stringLength(toolState.error)
            }
        }
    }
    return chars
}

function stringLength(value: unknown): number {
    if (typeof value === "string") {
        return value.length
    }
    try {
        return JSON.stringify(value).length
    } catch {
        return 0
    }
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`
    }
    return String(tokens)
}

/**
 * Render the reclaimable cost map into the compression nudge/guidance. Returns
 * an empty string when there is nothing worth pointing at.
 */
export function renderReclaimableGuidance(state: SessionState, messages: WithParts[]): string {
    const map = findReclaimableRegions(state, messages)
    const topUncovered = map.uncovered.filter((region) => region.estimatedTokens >= 800).slice(0, 3)
    const topBlocks = map.blockSummaries.slice(0, 5)

    if (topUncovered.length === 0 && topBlocks.length === 0) {
        return ""
    }

    const lines: string[] = ["RECLAIMABLE CONTEXT MAP (compress the LARGEST item first):"]

    if (topUncovered.length > 0) {
        lines.push(
            "- Uncovered raw content NOT yet compressed (these are sent in full every request):",
        )
        topUncovered.forEach((region, index) => {
            const pct =
                map.totalVisibleTokens > 0
                    ? Math.round((region.estimatedTokens / map.totalVisibleTokens) * 100)
                    : 0
            const marker = index === 0 ? "  ← COMPRESS THIS FIRST" : ""
            lines.push(
                `  * ${region.startRef}..${region.endRef}: ${region.messageCount} messages, ~${formatTokens(region.estimatedTokens)} tokens (~${pct}% of visible context)${marker}`,
            )
        })
    }

    if (topBlocks.length > 0) {
        const rendered = topBlocks.map(
            (entry) =>
                `${formatBlockRef(entry.blockId, state.idFormat)} (~${formatTokens(entry.summaryTokens)})`,
        )
        lines.push(
            `- Active compressed summaries (merge several into ONE parent when possible): ${rendered.join(", ")}`,
        )
    }

    if (topUncovered.length > 0) {
        lines.push(
            "- PRIORITY: Do NOT compress a small recent message while a larger uncovered region above remains. Start from the largest uncovered region, or fold it together with the following active block.",
        )
    }

    return lines.join("\n")
}
