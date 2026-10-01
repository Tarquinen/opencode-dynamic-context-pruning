import type { CompressionBlock, PruneMessagesState, SessionState } from "../state"
import { formatBlockRef, formatMessageIdTag, type IdFormat } from "../message-ids"
import type { AppliedCompressionResult, CompressionStateInput, SelectionResolution } from "./types"

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"

export function allocateBlockId(state: SessionState): number {
    const next = state.prune.messages.nextBlockId
    if (!Number.isInteger(next) || next < 1) {
        state.prune.messages.nextBlockId = 2
        return 1
    }

    state.prune.messages.nextBlockId = next + 1
    return next
}

export function allocateRunId(state: SessionState): number {
    const next = state.prune.messages.nextRunId
    if (!Number.isInteger(next) || next < 1) {
        state.prune.messages.nextRunId = 2
        return 1
    }

    state.prune.messages.nextRunId = next + 1
    return next
}

export function attachCompressionDuration(
    messagesState: PruneMessagesState,
    messageId: string,
    callId: string,
    durationMs: number,
): number {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
        return 0
    }

    let updates = 0
    for (const block of messagesState.blocksById.values()) {
        if (block.compressMessageId !== messageId || block.compressCallId !== callId) {
            continue
        }

        block.durationMs = durationMs
        updates++
    }

    return updates
}

export function wrapCompressedSummary(
    blockId: number,
    summary: string,
    format: IdFormat = "xml",
): string {
    const header = COMPRESSED_BLOCK_HEADER
    const footer = formatMessageIdTag(formatBlockRef(blockId, format), undefined, format)
    const body = summary.trim()
    if (body.length === 0) {
        return `${header}\n${footer}`
    }
    return `${header}\n${body}\n\n${footer}`
}

// What a range costs the context today: the raw messages it spans plus the
// summaries of the compressed blocks it will absorb. Without counting the blocks
// a repeated "b10..m0190" style range looks almost free, which is how a summary
// can end up larger than the content it replaced (#573).
export function selectionTokenCost(
    selection: Pick<SelectionResolution, "messageTokenById" | "requiredBlockIds">,
    messagesState: PruneMessagesState,
): number {
    let total = 0

    for (const tokens of selection.messageTokenById.values()) {
        total += tokens
    }

    for (const blockId of selection.requiredBlockIds) {
        const block = messagesState.blocksById.get(blockId)
        if (block) {
            total += block.summaryTokens || 0
        }
    }

    return total
}

// Below this the guard stays out of the way: compressing a handful of short
// messages into a slightly longer summary is a normal, deliberate choice, and
// tokenizer noise on very small texts would make the comparison unreliable. The
// runaway growth this guards against is orders of magnitude larger - the
// smallest pathological block in #573 was already ~1.6k tokens and grew from
// there to ~68k.
const MIN_GUARDED_INPUT_TOKENS = 2000

// A compression that does not shrink the context is pure loss: the original
// content is destroyed and the summary generation was still paid for. Refusing
// it leaves the caller free to pick a wider range instead of looping.
export function assertCompressionShrinksContext(
    summaryTokens: number,
    inputTokens: number,
    boundaryLabel: string,
    idFormat: IdFormat = "xml",
): void {
    if (inputTokens < MIN_GUARDED_INPUT_TOKENS || summaryTokens < inputTokens) {
        return
    }

    const id = idFormat === "compact" ? `@${boundaryLabel}@` : boundaryLabel
    throw new Error(
        `Refusing to compress ${id}: the summary is ~${summaryTokens} tokens but the content it would replace is only ~${inputTokens} tokens. ` +
            `A compression has to shrink the context. Choose a wider range, or leave this content uncompressed.`,
    )
}

export function applyCompressionState(
    state: SessionState,
    input: CompressionStateInput,
    selection: SelectionResolution,
    anchorMessageId: string,
    blockId: number,
    summary: string,
    consumedBlockIds: number[],
): AppliedCompressionResult {
    const messagesState = state.prune.messages
    const consumed = [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
    const included = [...consumed]

    const effectiveMessageIds = new Set<string>(selection.messageIds)
    const effectiveToolIds = new Set<string>(selection.toolIds)

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            effectiveMessageIds.add(messageId)
        }
        for (const toolId of consumedBlock.effectiveToolIds) {
            effectiveToolIds.add(toolId)
        }
    }

    const initiallyActiveMessages = new Set<string>()
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (entry && entry.activeBlockIds.length > 0) {
            initiallyActiveMessages.add(messageId)
        }
    }

    const initiallyActiveToolIds = new Set<string>()
    for (const activeBlockId of messagesState.activeBlockIds) {
        const activeBlock = messagesState.blocksById.get(activeBlockId)
        if (!activeBlock || !activeBlock.active) {
            continue
        }

        for (const toolId of activeBlock.effectiveToolIds) {
            initiallyActiveToolIds.add(toolId)
        }
    }

    const createdAt = Date.now()
    const block: CompressionBlock = {
        blockId,
        runId: input.runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: input.summaryTokens,
        durationMs: 0,
        mode: input.mode,
        topic: input.topic,
        batchTopic: input.batchTopic,
        startId: input.startId,
        endId: input.endId,
        anchorMessageId,
        compressMessageId: input.compressMessageId,
        compressCallId: input.compressCallId,
        includedBlockIds: included,
        consumedBlockIds: consumed,
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        createdAt,
        summary,
    }

    messagesState.blocksById.set(blockId, block)
    messagesState.activeBlockIds.add(blockId)
    messagesState.activeByAnchorMessageId.set(anchorMessageId, blockId)

    const deactivatedAt = Date.now()
    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock || !consumedBlock.active) {
            continue
        }

        consumedBlock.active = false
        consumedBlock.deactivatedAt = deactivatedAt
        consumedBlock.deactivatedByBlockId = blockId
        if (!consumedBlock.parentBlockIds.includes(blockId)) {
            consumedBlock.parentBlockIds.push(blockId)
        }

        messagesState.activeBlockIds.delete(consumedBlockId)
        const mappedBlockId = messagesState.activeByAnchorMessageId.get(
            consumedBlock.anchorMessageId,
        )
        if (mappedBlockId === consumedBlockId) {
            messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
        }
    }

    const removeActiveBlockId = (
        entry: { activeBlockIds: number[] },
        blockIdToRemove: number,
    ): void => {
        if (entry.activeBlockIds.length === 0) {
            return
        }
        entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== blockIdToRemove)
    }

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            const entry = messagesState.byMessageId.get(messageId)
            if (!entry) {
                continue
            }
            removeActiveBlockId(entry, consumedBlockId)
        }
    }

    for (const messageId of selection.messageIds) {
        const tokenCount = selection.messageTokenById.get(messageId) || 0
        const existing = messagesState.byMessageId.get(messageId)

        if (!existing) {
            messagesState.byMessageId.set(messageId, {
                tokenCount,
                allBlockIds: [blockId],
                activeBlockIds: [blockId],
            })
            continue
        }

        existing.tokenCount = Math.max(existing.tokenCount, tokenCount)
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    for (const messageId of block.effectiveMessageIds) {
        if (selection.messageTokenById.has(messageId)) {
            continue
        }

        const existing = messagesState.byMessageId.get(messageId)
        if (!existing) {
            continue
        }
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    let compressedTokens = 0
    const newlyCompressedMessageIds: string[] = []
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (!entry) {
            continue
        }

        const isNowActive = entry.activeBlockIds.length > 0
        const wasActive = initiallyActiveMessages.has(messageId)

        if (isNowActive && !wasActive) {
            compressedTokens += entry.tokenCount
            newlyCompressedMessageIds.push(messageId)
        }
    }

    const newlyCompressedToolIds: string[] = []
    for (const toolId of effectiveToolIds) {
        if (!initiallyActiveToolIds.has(toolId)) {
            newlyCompressedToolIds.push(toolId)
        }
    }

    block.directMessageIds = [...newlyCompressedMessageIds]
    block.directToolIds = [...newlyCompressedToolIds]

    block.compressedTokens = compressedTokens

    state.stats.pruneTokenCounter += compressedTokens
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0

    return {
        compressedTokens,
        messageIds: selection.messageIds,
        newlyCompressedMessageIds,
        newlyCompressedToolIds,
    }
}
