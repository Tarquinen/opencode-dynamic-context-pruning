import type {
    CompressionBlock,
    PersistedPruneMessagesState,
    PruneMessagesState,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "./types"
import { isIgnoredUserMessage, messageHasCompress } from "../messages/query"
import { isMessageWithInfo } from "../messages/shape"
import { countTokens } from "../token-utils"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    if (!isMessageWithInfo(msg)) {
        return false
    }

    if (msg.info.time.created < state.lastCompaction) {
        return true
    }
    const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        return true
    }
    return false
}

export function serializePruneMessagesState(
    messagesState: PruneMessagesState,
): PersistedPruneMessagesState {
    return {
        byMessageId: Object.fromEntries(messagesState.byMessageId),
        blocksById: Object.fromEntries(
            Array.from(messagesState.blocksById.entries()).map(([blockId, block]) => [
                String(blockId),
                block,
            ]),
        ),
        activeBlockIds: Array.from(messagesState.activeBlockIds),
        activeByAnchorMessageId: Object.fromEntries(messagesState.activeByAnchorMessageId),
        nextBlockId: messagesState.nextBlockId,
        nextRunId: messagesState.nextRunId,
    }
}

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function loadPruneMap(obj?: Record<string, number>): Map<string, number> {
    if (!obj || typeof obj !== "object") {
        return new Map()
    }

    const entries = Object.entries(obj).filter(
        (entry): entry is [string, number] =>
            typeof entry[0] === "string" && typeof entry[1] === "number",
    )
    return new Map(entries)
}

export function createPruneMessagesState(): PruneMessagesState {
    return {
        byMessageId: new Map<string, PrunedMessageEntry>(),
        blocksById: new Map<number, CompressionBlock>(),
        activeBlockIds: new Set<number>(),
        activeByAnchorMessageId: new Map<string, number>(),
        nextBlockId: 1,
        nextRunId: 1,
    }
}

/** Guards for untrusted on-disk state. A malformed value falls back to the default. */
const isPosInt = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0

const isNonNegNum = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0

const isStr = (value: unknown): value is string => typeof value === "string"

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

/** Filter to positive integers, order preserved, duplicates dropped. */
const posIntArray = (value: unknown): number[] =>
    Array.isArray(value) ? [...new Set(value.filter(isPosInt))] : []

/** Filter to strings, order preserved, duplicates dropped. */
const strArray = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter(isStr))] : []

function deserializeBlock(blockId: number, block: CompressionBlock): CompressionBlock {
    return {
        blockId,
        runId: isPosInt(block.runId) ? block.runId : blockId,
        active: block.active === true,
        deactivatedByUser: block.deactivatedByUser === true,
        compressedTokens: isNonNegNum(block.compressedTokens) ? block.compressedTokens : 0,
        summaryTokens: isNonNegNum(block.summaryTokens)
            ? block.summaryTokens
            : isStr(block.summary)
              ? countTokens(block.summary)
              : 0,
        durationMs: isNonNegNum(block.durationMs) ? block.durationMs : 0,
        mode: block.mode === "range" || block.mode === "message" ? block.mode : undefined,
        topic: isStr(block.topic) ? block.topic : "",
        batchTopic: isStr(block.batchTopic) ? block.batchTopic : (block.topic ?? ""),
        startId: isStr(block.startId) ? block.startId : "",
        endId: isStr(block.endId) ? block.endId : "",
        anchorMessageId: isStr(block.anchorMessageId) ? block.anchorMessageId : "",
        compressMessageId: isStr(block.compressMessageId) ? block.compressMessageId : "",
        compressCallId: isStr(block.compressCallId) ? block.compressCallId : undefined,
        includedBlockIds: posIntArray(block.includedBlockIds),
        consumedBlockIds: posIntArray(block.consumedBlockIds),
        parentBlockIds: posIntArray(block.parentBlockIds),
        directMessageIds: strArray(block.directMessageIds),
        directToolIds: strArray(block.directToolIds),
        effectiveMessageIds: strArray(block.effectiveMessageIds),
        effectiveToolIds: strArray(block.effectiveToolIds),
        createdAt: typeof block.createdAt === "number" ? block.createdAt : 0,
        deactivatedAt: typeof block.deactivatedAt === "number" ? block.deactivatedAt : undefined,
        deactivatedByBlockId: isPosInt(block.deactivatedByBlockId)
            ? block.deactivatedByBlockId
            : undefined,
        summary: isStr(block.summary) ? block.summary : "",
    }
}

export function loadPruneMessagesState(
    persisted?: PersistedPruneMessagesState,
): PruneMessagesState {
    const state = createPruneMessagesState()
    if (!isRecord(persisted)) {
        return state
    }

    for (const [messageId, entry] of Object.entries(
        isRecord(persisted.byMessageId) ? persisted.byMessageId : {},
    )) {
        if (!isRecord(entry)) {
            continue
        }

        state.byMessageId.set(messageId, {
            tokenCount: typeof entry.tokenCount === "number" ? entry.tokenCount : 0,
            allBlockIds: posIntArray(entry.allBlockIds),
            activeBlockIds: posIntArray(entry.activeBlockIds),
        })
    }

    for (const [blockIdStr, block] of Object.entries(
        isRecord(persisted.blocksById) ? persisted.blocksById : {},
    )) {
        const blockId = Number.parseInt(blockIdStr, 10)
        if (!isPosInt(blockId) || !isRecord(block)) {
            continue
        }

        state.blocksById.set(blockId, deserializeBlock(blockId, block as CompressionBlock))
    }

    for (const [anchorMessageId, blockId] of Object.entries(
        isRecord(persisted.activeByAnchorMessageId) ? persisted.activeByAnchorMessageId : {},
    )) {
        if (!isPosInt(blockId)) {
            continue
        }
        state.activeByAnchorMessageId.set(anchorMessageId, blockId)
    }

    // The block list is authoritative: a block marked active repopulates both indexes.
    // Serialization writes those indexes from this same source, so the persisted
    // copies of them are redundant.
    for (const [blockId, block] of state.blocksById) {
        if (block.active) {
            state.activeBlockIds.add(blockId)
            if (block.anchorMessageId) {
                state.activeByAnchorMessageId.set(block.anchorMessageId, blockId)
            }
        }
        if (blockId >= state.nextBlockId) {
            state.nextBlockId = blockId + 1
        }
        if (block.runId >= state.nextRunId) {
            state.nextRunId = block.runId + 1
        }
    }

    return state
}

export function collectTurnNudgeAnchors(messages: WithParts[]): Set<string> {
    const anchors = new Set<string>()
    let pendingUserMessageId: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        if (messageHasCompress(message)) {
            break
        }

        if (message.info.role === "user") {
            if (!isIgnoredUserMessage(message)) {
                pendingUserMessageId = message.info.id
            }
            continue
        }

        if (message.info.role === "assistant" && pendingUserMessageId) {
            anchors.add(message.info.id)
            anchors.add(pendingUserMessageId)
            pendingUserMessageId = null
        }
    }

    return anchors
}

export function getActiveSummaryTokenUsage(state: SessionState): number {
    let total = 0
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || !block.active) {
            continue
        }
        total += block.summaryTokens
    }
    return total
}

export function resetOnCompaction(state: SessionState): void {
    state.toolParameters.clear()
    state.prune.tools = new Map<string, number>()
    state.prune.messages = createPruneMessagesState()
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
}
