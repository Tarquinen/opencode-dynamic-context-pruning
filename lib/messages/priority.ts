import type { PluginConfig } from "../config"
import { countAllMessageTokens } from "../token-utils"
import { isMessageCompacted } from "../state/utils"
import type { SessionState, WithParts } from "../state"
import { isIgnoredUserMessage, isProtectedUserMessage, messageHasCompress } from "./query"

const MEDIUM_PRIORITY_MIN_TOKENS = 500
const HIGH_PRIORITY_MIN_TOKENS = 5000

export type MessagePriority = "low" | "medium" | "high"

export interface CompressionPriorityEntry {
    ref: string
    tokenCount: number
    priority: MessagePriority
}

export type CompressionPriorityMap = Map<string, CompressionPriorityEntry>

export async function buildPriorityMap(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
): Promise<CompressionPriorityMap> {
    if (config.compress.mode !== "message") {
        return new Map()
    }
    const priorities: CompressionPriorityMap = new Map()

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        if (isProtectedUserMessage(config, message)) {
            continue
        }

        if (isMessageCompacted(state, message)) {
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }

        const ref = state.messageIds.byRawId.get(rawMessageId)
        if (!ref) {
            continue
        }

        const tokenCount = await countAllMessageTokens(message)
        priorities.set(rawMessageId, {
            ref,
            tokenCount,
            priority: messageHasCompress(message) ? "high" : classifyMessagePriority(tokenCount),
        })
    }

    return priorities
}

export function classifyMessagePriority(tokenCount: number): MessagePriority {
    if (tokenCount >= HIGH_PRIORITY_MIN_TOKENS) {
        return "high"
    }

    if (tokenCount >= MEDIUM_PRIORITY_MIN_TOKENS) {
        return "medium"
    }

    return "low"
}

export function listPriorityRefsBeforeIndex(
    messages: WithParts[],
    priorities: CompressionPriorityMap,
    anchorIndex: number,
    priority: MessagePriority,
): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    const upperBound = Math.max(0, Math.min(anchorIndex, messages.length))

    for (let index = 0; index < upperBound; index++) {
        const rawMessageId = messages[index]?.info.id
        if (typeof rawMessageId !== "string") {
            continue
        }

        const entry = priorities.get(rawMessageId)
        if (!entry || entry.priority !== priority || seen.has(entry.ref)) {
            continue
        }

        seen.add(entry.ref)
        refs.push(entry.ref)
    }

    return refs
}
