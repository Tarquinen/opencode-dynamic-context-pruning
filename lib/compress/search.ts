import type { SessionState, WithParts } from "../state"
import { formatBlockRef, parseBoundaryId } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { filterMessages } from "../messages/shape"
import { countAllMessageTokens } from "../token-utils"
import type { BoundaryReference, SearchContext, SelectionResolution } from "./types"

export async function fetchSessionMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

export function buildSearchContext(state: SessionState, rawMessages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (const msg of rawMessages) {
        rawMessagesById.set(msg.info.id, msg)
    }
    for (let index = 0; index < rawMessages.length; index++) {
        const message = rawMessages[index]
        if (!message) {
            continue
        }
        rawIndexById.set(message.info.id, index)
    }

    const summaryByBlockId = new Map()
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) {
            continue
        }
        summaryByBlockId.set(blockId, block)
    }

    return {
        rawMessages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId,
    }
}

export function resolveBoundaryIds(
    context: SearchContext,
    state: SessionState,
    startId: string,
    endId: string,
): { startReference: BoundaryReference; endReference: BoundaryReference } {
    const lookup = buildBoundaryLookup(context, state)
    const issues: string[] = []
    const parsedStartId = parseBoundaryId(startId, state.idFormat)
    const parsedEndId = parseBoundaryId(endId, state.idFormat)
    const messageExample = state.idFormat === "compact" ? "@4@" : "mNNNN"
    const blockExample = state.idFormat === "compact" ? "@b1@" : "bN"

    if (parsedStartId === null) {
        issues.push(
            `startId is invalid. Use an injected message ID (${messageExample}) or block ID (${blockExample}).`,
        )
    }

    if (parsedEndId === null) {
        issues.push(
            `endId is invalid. Use an injected message ID (${messageExample}) or block ID (${blockExample}).`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (!parsedStartId || !parsedEndId) {
        throw new Error("Invalid boundary ID(s)")
    }

    const startReference = lookup.get(parsedStartId.ref)
    const endReference = lookup.get(parsedEndId.ref)

    if (!startReference) {
        issues.push(
            `startId ${parsedStartId.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }

    if (!endReference) {
        issues.push(
            `endId ${parsedEndId.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (!startReference || !endReference) {
        throw new Error("Failed to resolve boundary IDs")
    }

    if (startReference.rawIndex > endReference.rawIndex) {
        throw new Error(
            `startId ${parsedStartId.ref} appears after endId ${parsedEndId.ref} in the conversation. Start must come before end.`,
        )
    }

    return { startReference, endReference }
}

export async function resolveSelection(
    context: SearchContext,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): Promise<SelectionResolution> {
    const startRawIndex = startReference.rawIndex
    const endRawIndex = endReference.rawIndex
    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const requiredBlockIds: number[] = []
    const requiredBlockSeen = new Set<number>()
    const messageTokenById = new Map<string, number>()

    for (let index = startRawIndex; index <= endRawIndex; index++) {
        const rawMessage = context.rawMessages[index]
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const messageId = rawMessage.info.id
        if (!messageSeen.has(messageId)) {
            messageSeen.add(messageId)
            messageIds.push(messageId)
        }

        if (!messageTokenById.has(messageId)) {
            messageTokenById.set(messageId, await countAllMessageTokens(rawMessage))
        }

        const parts = Array.isArray(rawMessage.parts) ? rawMessage.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) {
                continue
            }
            if (toolSeen.has(part.callID)) {
                continue
            }
            toolSeen.add(part.callID)
            toolIds.push(part.callID)
        }
    }

    const selectedMessageIds = new Set(messageIds)
    const summariesInSelection: Array<{ blockId: number; rawIndex: number }> = []
    for (const summary of context.summaryByBlockId.values()) {
        if (!selectedMessageIds.has(summary.anchorMessageId)) {
            continue
        }

        const anchorIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (anchorIndex === undefined) {
            continue
        }

        summariesInSelection.push({
            blockId: summary.blockId,
            rawIndex: anchorIndex,
        })
    }

    summariesInSelection.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId)
    for (const summary of summariesInSelection) {
        if (requiredBlockSeen.has(summary.blockId)) {
            continue
        }
        requiredBlockSeen.add(summary.blockId)
        requiredBlockIds.push(summary.blockId)
    }

    if (messageIds.length === 0) {
        throw new Error(
            "Failed to map boundary matches back to raw messages. Choose boundaries that include original conversation messages.",
        )
    }

    return {
        startReference,
        endReference,
        messageIds,
        messageTokenById,
        toolIds,
        requiredBlockIds,
    }
}

export function resolveAnchorMessageId(startReference: BoundaryReference): string {
    if (startReference.kind === "compressed-block") {
        if (!startReference.anchorMessageId) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        return startReference.anchorMessageId
    }

    if (!startReference.messageId) {
        throw new Error("Failed to map boundary matches back to raw messages")
    }
    return startReference.messageId
}

function buildBoundaryLookup(
    context: SearchContext,
    state: SessionState,
): Map<string, BoundaryReference> {
    const lookup = new Map<string, BoundaryReference>()

    for (const [messageRef, messageId] of state.messageIds.byRef) {
        const rawMessage = context.rawMessagesById.get(messageId)
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(messageId)
        if (rawIndex === undefined) {
            continue
        }
        lookup.set(messageRef, {
            kind: "message",
            rawIndex,
            messageId,
        })
    }

    const summaries = Array.from(context.summaryByBlockId.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    for (const summary of summaries) {
        const anchorMessage = context.rawMessagesById.get(summary.anchorMessageId)
        if (!anchorMessage) {
            continue
        }
        if (isIgnoredUserMessage(anchorMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (rawIndex === undefined) {
            continue
        }
        const blockRef = formatBlockRef(summary.blockId, state.idFormat)
        if (!lookup.has(blockRef)) {
            lookup.set(blockRef, {
                kind: "compressed-block",
                rawIndex,
                blockId: summary.blockId,
                anchorMessageId: summary.anchorMessageId,
            })
        }
    }

    return lookup
}
