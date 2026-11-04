import type { SessionState } from "../state"
import { countTokens } from "../token-utils"
import { wrapCompressedSummary } from "./state"
import type { SelectionResolution } from "./types"

const BLOCK_REF_PATTERNS = [
    (blockId: number) => new RegExp(`### \\(b${blockId}\\)[^\\n]*\\n?`, "g"),
    (blockId: number) => new RegExp(`\\(b${blockId}\\)`, "g"),
    (blockId: number) => new RegExp(`\\{block_${blockId}\\}`, "g"),
    (blockId: number) => new RegExp(`\\[condensed block b${blockId}\\]`, "g"),
    (blockId: number) => new RegExp(`### compressed block ${blockId}[^\\n]*\\n?`, "g"),
    (blockId: number) => new RegExp(`@b${blockId}@`, "g"),
]

export function stripSelfReferences(body: string, blockId: number): string {
    let cleaned = body
    for (const pattern of BLOCK_REF_PATTERNS) {
        cleaned = cleaned.replace(pattern(blockId), "")
    }
    return cleaned
        .replace(/[ \t]{2,}/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .trim()
}

/**
 * A compression is a "pure single-block re-wrap" when its range resolves to
 * exactly one already-active block and covers NO new raw messages or tools.
 * Accepting it would create a new parent block that just re-wraps the same
 * content (e.g. the degenerate bN -> bN+1 chains seen in long sessions), adding
 * a block without reclaiming any context. Returns the block id to recondense in
 * place, or null when the plan adds genuinely new coverage (a real merge).
 */
export function isSingleBlockRewrap(
    state: SessionState,
    selection: SelectionResolution,
): number | null {
    if (selection.requiredBlockIds.length !== 1) {
        return null
    }

    const blockId = selection.requiredBlockIds[0]
    if (blockId === undefined) {
        return null
    }

    const block = state.prune.messages.blocksById.get(blockId)
    if (!block || !block.active) {
        return null
    }

    for (const messageId of selection.messageIds) {
        const entry = state.prune.messages.byMessageId.get(messageId)
        if (!entry) {
            return null
        }
        if (entry.activeBlockIds.length === 0) {
            return null
        }
    }

    const coveredTools = new Set(block.effectiveToolIds)
    for (const toolId of selection.toolIds) {
        if (!coveredTools.has(toolId)) {
            return null
        }
    }

    return blockId
}

/**
 * Rewrite an existing block's summary in place without allocating a new block,
 * deactivating the old one, or touching the byMessageId / anchor maps. Used to
 * collapse single-block re-wrap chains: the newest condensation replaces the
 * block it would otherwise have wrapped.
 */
export function recondenseBlockInPlace(
    state: SessionState,
    blockId: number,
    body: string,
): { replaced: boolean; summaryTokens: number } {
    const block = state.prune.messages.blocksById.get(blockId)
    if (!block) {
        return { replaced: false, summaryTokens: 0 }
    }

    const wrapped = wrapCompressedSummary(
        blockId,
        stripSelfReferences(body, blockId),
        state.idFormat,
    )
    const summaryTokens = countTokens(wrapped)
    if (block.summaryTokens > 0 && summaryTokens >= block.summaryTokens) {
        return { replaced: false, summaryTokens }
    }

    block.summary = wrapped
    block.summaryTokens = summaryTokens
    return { replaced: true, summaryTokens }
}
