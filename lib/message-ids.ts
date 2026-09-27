import type { SessionState, WithParts } from "./state"
import { isIgnoredUserMessage } from "./messages/query"

const MESSAGE_REF_REGEX = /^m(\d{4,5})$/
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/
const COMPACT_MESSAGE_REGEX = /^@([1-9]\d*)@$/
const COMPACT_BLOCK_REGEX = /^@b([1-9]\d*)@$/
const MESSAGE_ID_TAG_NAME = "dcp-message-id"

export type IdFormat = "xml" | "compact"

// Aliases render as m0001 and only widen to a fifth digit once the four digit
// space is exhausted, so existing sessions keep byte-identical tags.
const MESSAGE_REF_MIN_WIDTH = 4
const MESSAGE_REF_MIN_INDEX = 1
export const MESSAGE_REF_MAX_INDEX = 99999

export type ParsedBoundaryId =
    | {
          kind: "message"
          ref: string
          index: number
      }
    | {
          kind: "compressed-block"
          ref: string
          blockId: number
      }

export function formatMessageRef(index: number, format: IdFormat = "xml"): string {
    const max = format === "compact" ? Number.MAX_SAFE_INTEGER : MESSAGE_REF_MAX_INDEX
    if (!Number.isSafeInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > max) {
        throw new Error(`Message ID index out of bounds: ${index}. Supported range is 1-${max}.`)
    }
    return format === "compact"
        ? `@${index}@`
        : `m${index.toString().padStart(Math.max(MESSAGE_REF_MIN_WIDTH, `${index}`.length), "0")}`
}

export function formatBlockRef(blockId: number, format: IdFormat = "xml"): string {
    if (!Number.isInteger(blockId) || blockId < 1) {
        throw new Error(`Invalid block ID: ${blockId}`)
    }
    return format === "compact" ? `@b${blockId}@` : `b${blockId}`
}

export function parseMessageRef(ref: string, format: IdFormat = "xml"): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(format === "compact" ? COMPACT_MESSAGE_REGEX : MESSAGE_REF_REGEX)
    if (!match) {
        return null
    }
    const index = Number.parseInt(match[1], 10)
    if (!Number.isSafeInteger(index)) {
        return null
    }
    const max = format === "compact" ? Number.MAX_SAFE_INTEGER : MESSAGE_REF_MAX_INDEX
    if (index < MESSAGE_REF_MIN_INDEX || index > max) {
        return null
    }
    return index
}

export function parseBlockRef(ref: string, format: IdFormat = "xml"): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(format === "compact" ? COMPACT_BLOCK_REGEX : BLOCK_REF_REGEX)
    if (!match) {
        return null
    }
    const id = Number.parseInt(match[1], 10)
    return Number.isSafeInteger(id) ? id : null
}

export function parseBoundaryId(id: string, format: IdFormat = "xml"): ParsedBoundaryId | null {
    const normalized = id.trim().toLowerCase()
    const messageIndex = parseMessageRef(normalized, format)
    if (messageIndex !== null) {
        return {
            kind: "message",
            ref: formatMessageRef(messageIndex, format),
            index: messageIndex,
        }
    }

    const blockId = parseBlockRef(normalized, format)
    if (blockId !== null) {
        return {
            kind: "compressed-block",
            ref: formatBlockRef(blockId, format),
            blockId,
        }
    }

    return null
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

export function formatMessageIdTag(
    ref: string,
    attributes?: Record<string, string | undefined>,
    format: IdFormat = "xml",
): string {
    if (format === "compact") {
        if (ref === "BLOCKED") return "\n@blocked@"
        const priority = attributes?.priority
        return `\n${ref}${priority ? ` [${priority}]` : ""}`
    }
    const serializedAttributes = Object.entries(attributes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            if (name.trim().length === 0 || typeof value !== "string" || value.length === 0) {
                return ""
            }

            return ` ${name}="${escapeXmlAttribute(value)}"`
        })
        .join("")

    return `\n<${MESSAGE_ID_TAG_NAME}${serializedAttributes}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

// Aliases are a fixed size resource, but the conversation can shrink: opencode
// drops old messages on its own compaction, and /fork plus /undo rewrite the
// message list. Without reclaiming them the pool leaks for the lifetime of a
// session and can be exhausted even when few messages remain.
function reclaimStaleMessageRefs(state: SessionState, messages: WithParts[]): void {
    if (state.messageIds.byRawId.size === 0) {
        return
    }

    const liveIds = new Set<string>()
    for (const message of messages) {
        const id = message.info?.id
        if (typeof id === "string" && id.length > 0) {
            liveIds.add(id)
        }
    }

    for (const [rawId, ref] of state.messageIds.byRawId) {
        if (liveIds.has(rawId)) {
            continue
        }
        if (state.messageIds.byRef.get(ref) === rawId) {
            state.messageIds.byRef.delete(ref)
        }
        state.messageIds.byRawId.delete(rawId)
    }
}

export function assignMessageRefs(state: SessionState, messages: WithParts[]): number {
    let assigned = 0
    let skippedSubAgentPrompt = false

    reclaimStaleMessageRefs(state, messages)

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        if (state.isSubAgent && !skippedSubAgentPrompt && message.info.role === "user") {
            skippedSubAgentPrompt = true
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }

        const existingRef = state.messageIds.byRawId.get(rawMessageId)
        if (existingRef) {
            if (state.messageIds.byRef.get(existingRef) !== rawMessageId) {
                state.messageIds.byRef.set(existingRef, rawMessageId)
            }
            continue
        }

        const ref = allocateNextMessageRef(state)
        state.messageIds.byRawId.set(rawMessageId, ref)
        state.messageIds.byRef.set(ref, rawMessageId)
        assigned++
    }

    return assigned
}

function allocateNextMessageRef(state: SessionState): string {
    let candidate = Number.isInteger(state.messageIds.nextRef)
        ? Math.max(MESSAGE_REF_MIN_INDEX, state.messageIds.nextRef)
        : MESSAGE_REF_MIN_INDEX

    const max = state.idFormat === "compact" ? Number.MAX_SAFE_INTEGER : MESSAGE_REF_MAX_INDEX
    while (candidate <= max) {
        const ref = formatMessageRef(candidate, state.idFormat)
        if (!state.messageIds.byRef.has(ref)) {
            state.messageIds.nextRef = candidate + 1
            return ref
        }
        candidate++
    }

    throw new Error(
        `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(max, state.idFormat)} aliases in this session. ` +
            `Start a new session to continue; removing the plugin from opencode.json also unblocks the current one.`,
    )
}
