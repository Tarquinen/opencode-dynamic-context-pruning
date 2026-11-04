import type { CompressionBlock, PruneMessagesState, ProtectedContent, SessionState } from "../state"
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

export function applyCompressionState(
    state: SessionState,
    input: CompressionStateInput,
    selection: SelectionResolution,
    anchorMessageId: string,
    blockId: number,
    summary: string,
    consumedBlockIds: number[],
    protectedContent: ProtectedContent[] = [],
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
        protectedContent,
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
