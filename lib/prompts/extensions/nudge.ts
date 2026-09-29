import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import { isMessageCompacted } from "../../state/utils"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../../messages/query"
import { formatBlockRef } from "../../message-ids"

function formatTokenEstimate(tokens: number): string {
    if (tokens >= 1000) {
        return `~${(tokens / 1000).toFixed(1)}k`
    }
    return `~${tokens}`
}

/**
 * Occupancy guidance for compressed blocks. Block summaries stay in the model's
 * context forever, and in a heavily compressed session they are the largest
 * occupants - but the model only ever saw their labels, so it concluded there
 * was nothing left to compress. Making their cost visible and giving the model
 * an explicit decision order (drop what is no longer needed, merge only what
 * must survive the whole session, leave anything uncertain alone) fixes that
 * blind spot.
 */
export function buildCompressedBlockGuidance(state: SessionState): string {
    const blocksById = state.prune.messages.blocksById
    // activeBlockIds are persisted and restored from disk; intersect with
    // blocksById so a block missing from disk (corrupt/older state file) is
    // not listed with a bogus "~0 tokens" cost.
    const activeIds = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0 && blocksById.has(id))
        .sort((a, b) => a - b)
    const refs = activeIds.map((id) => formatBlockRef(id, state.idFormat))
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"
    const placeholder = state.idFormat === "compact" ? "@b1@" : "(bN)"

    const lines = [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
    ]

    if (blockCount === 0) {
        lines.push(
            `- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using \`${placeholder}\`.`,
        )
        return lines.join("\n")
    }

    const sized = activeIds
        .map((id) => ({ id, tokens: state.prune.messages.blocksById.get(id)?.summaryTokens ?? 0 }))
        .sort((a, b) => b.tokens - a.tokens)
    const totalTokens = sized.reduce((total, block) => total + block.tokens, 0)

    lines.push(
        "- Block summaries are part of your context and consume real tokens. Largest:",
    )
    const MAX_LISTED_BLOCKS = 8
    const listed = sized.slice(0, MAX_LISTED_BLOCKS)
    for (const block of listed) {
        lines.push(`  - ${formatBlockRef(block.id, state.idFormat)}: ${formatTokenEstimate(block.tokens)} tokens`)
    }
    const hiddenBlocks = sized.length - listed.length
    if (hiddenBlocks > 0) {
        lines.push(`  - ... +${hiddenBlocks} smaller`)
    }
    lines.push(`- Total held by block summaries: ${formatTokenEstimate(totalTokens)} tokens.`)
    lines.push(
        "- Decision order: (1) DROP ranges no longer needed - a compress range removes their raw text and tool outputs from context entirely, the biggest win. (2) MERGE only content needed for as long as this session lives: compress a range covering those blocks (e.g. " +
            formatBlockRef(1, state.idFormat) +
            ".." +
            formatBlockRef(8, state.idFormat) +
            ") and reference each included block exactly once as `" +
            placeholder +
            "` in the new summary. (3) Leave anything uncertain alone.",
    )
    lines.push(
        "- Merge caveat: merges are lossy and fuse blocks; merged blocks can no longer be dropped or re-compressed separately. Keep blocks standalone unless they must persist to the end of the session.",
    )
    return lines.join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}

const SYNTHETIC_SUMMARY_PREFIX = "msg_dcp_summary"
const MAX_REPORTED_MESSAGES = 8

function estimateMessageTokens(message: WithParts): { tokens: number; toolOutputs: number } {
    let chars = 0
    let toolOutputs = 0
    for (const part of message.parts ?? []) {
        if (part.type === "text" || part.type === "reasoning") {
            chars += (part.text ?? "").length
            continue
        }
        if (part.type === "tool") {
            toolOutputs += 1
            chars += JSON.stringify(part.state ?? {}).length
            continue
        }
        if (part.type === "file") {
            // Projected media (v2) carries its payload/base64 in `url`; the
            // model sees it, so it must count toward the drop-candidate cost.
            chars += (part.url ?? "").length
        }
    }
    return { tokens: Math.round(chars / 4), toolOutputs }
}

/**
 * Size visibility for uncompressed messages. The model sees this content but
 * has no cost model for it, so manual compress triggers fixate on recent text
 * while hundreds of KB of old tool outputs ride along in every request.
 * Naming the top offenders (with their message refs) makes them targetable.
 */
export function buildMessageOccupancyGuidance(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): string {
    const sized: Array<{
        ref: string
        role: string
        tokens: number
        toolOutputs: number
        protectedMsg: boolean
    }> = []

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) continue
        if (message.info.id.startsWith(SYNTHETIC_SUMMARY_PREFIX)) continue
        if (isMessageCompacted(state, message)) continue
        const ref = state.messageIds.byRawId.get(message.info.id)
        if (!ref) continue
        const { tokens, toolOutputs } = estimateMessageTokens(message)
        if (tokens <= 0) continue
        sized.push({
            ref,
            role: message.info.role,
            tokens,
            toolOutputs,
            protectedMsg: message.info.role === "user" && isProtectedUserMessage(config, message),
        })
    }

    if (sized.length === 0) {
        return ""
    }

    sized.sort((a, b) => b.tokens - a.tokens)
    const lines = [
        "Largest uncompressed messages. Anything here that is no longer needed is a DROP target: a compress range over it removes its text and tool outputs from context entirely:",
    ]
    for (const entry of sized.slice(0, MAX_REPORTED_MESSAGES)) {
        const tools = entry.toolOutputs > 0 ? `, ${entry.toolOutputs} tool output${entry.toolOutputs === 1 ? "" : "s"}` : ""
        const flag = entry.protectedMsg ? ", protected" : ""
        lines.push(`- ${entry.ref} (${entry.role}, ${formatTokenEstimate(entry.tokens)} tokens${tools}${flag})`)
    }
    return lines.join("\n")
}
