import { createHash } from "node:crypto"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../state/utils"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { IdFormat } from "../message-ids"

const SUMMARY_ID_HASH_LENGTH = 16
const DCP_BLOCK_ID_TAG_REGEX = /(<dcp-message-id(?=[\s>])[^>]*>)b\d+(<\/dcp-message-id>)/g
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi
const INJECTED_MESSAGE_ID_SUFFIX_REGEX = /(?<=\n)<dcp-message-id[^>]*>m\d+<\/dcp-message-id>\s*$/
const HALLUCINATED_PARAMETER_SUFFIX_REGEX = /(?<=\n)m\d+<\/parameter>\s*$/
const COMPACT_TAG_REGEX = /@(?:[1-9]\d*|b[1-9]\d*|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?/gi
// Models that imitate the injected tag often emit broken fragments instead of a
// well formed one: a run of trailing lines made only of bracket debris such as
// "<<", "<" or "<m0477" (see #562). The run is anchored to the end of the reply
// and needs at least two lines, so a lone "<" in prose, markdown or code stays
// intact.
const DEGENERATE_TAG_LINE_PATTERN = String.raw`[ \t]*<{1,2}\/?[ \t]*(?:dcp[a-z-]*|m\d+|b\d+)?[ \t]*>?[ \t]*`
const DEGENERATE_TAG_DEBRIS_REGEX = new RegExp(
    String.raw`(?:\n${DEGENERATE_TAG_LINE_PATTERN}){2,}\n?$`,
)

const generateStableId = (prefix: string, seed: string): string => {
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH)
    return `${prefix}_${hash}`
}

export const createSyntheticUserMessage = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
): WithParts => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const messageId = generateStableId("msg_dcp_summary", deterministicSeed)
    const partId = generateStableId("prt_dcp_summary", deterministicSeed)

    return {
        info: {
            id: messageId,
            sessionID: userInfo.sessionID,
            role: "user" as const,
            agent: userInfo.agent,
            model: userInfo.model,
            time: { created: now },
        },
        parts: [
            {
                id: partId,
                sessionID: userInfo.sessionID,
                messageID: messageId,
                type: "text" as const,
                text: content,
            },
        ],
    }
}

export const createSyntheticTextPart = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
) => {
    const userInfo = baseMessage.info as UserMessage
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const partId = generateStableId("prt_dcp_text", deterministicSeed)

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "text" as const,
        text: content,
    }
}

type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>
type TextPart = Extract<MessagePart, { type: "text" }>

export const appendToLastTextPart = (message: WithParts, injection: string): boolean => {
    const textPart = findLastTextPart(message)
    if (!textPart) {
        return false
    }

    return appendToTextPart(textPart, injection)
}

const findLastTextPart = (message: WithParts): TextPart | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i]
        if (part.type === "text") {
            return part
        }
    }

    return null
}

export const appendToTextPart = (part: TextPart, injection: string): boolean => {
    if (typeof part.text !== "string") {
        return false
    }

    const normalizedInjection = injection.replace(/^\n+/, "")
    if (!normalizedInjection.trim()) {
        return false
    }
    if (part.text.includes(normalizedInjection)) {
        return true
    }

    const baseText = part.text.replace(/\n*$/, "")
    part.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
    return true
}

export const appendToAllToolParts = (message: WithParts, tag: string): boolean => {
    let injected = false
    for (const part of message.parts) {
        if (part.type === "tool") {
            injected = appendToToolPart(part, tag) || injected
        }
    }
    return injected
}

export const appendToToolPart = (part: ToolPart, tag: string): boolean => {
    if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
        return false
    }
    if (part.state.output.includes(tag)) {
        return true
    }

    part.state.output = `${part.state.output}${tag}`
    return true
}

export const hasContent = (message: WithParts): boolean => {
    return message.parts.some(
        (part) =>
            (part.type === "text" &&
                typeof part.text === "string" &&
                part.text.trim().length > 0) ||
            (part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"),
    )
}

export function buildToolIdList(state: SessionState, messages: WithParts[]): string[] {
    const toolIds: string[] = []
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        if (parts.length > 0) {
            for (const part of parts) {
                if (part.type === "tool" && part.callID && part.tool) {
                    toolIds.push(part.callID)
                }
            }
        }
    }
    state.toolIdList = toolIds
    return toolIds
}

export const replaceBlockIdsWithBlocked = (text: string, format: IdFormat = "xml"): string => {
    if (format === "compact") return text.replace(/@b[1-9]\d*@/gi, "@blocked@")
    return text.replace(DCP_BLOCK_ID_TAG_REGEX, "$1BLOCKED$2")
}

export const stripHallucinationsFromString = (text: string, format: IdFormat = "xml"): string => {
    if (format === "compact") text = text.replace(COMPACT_TAG_REGEX, "")
    const withoutKnownSuffixes = text
        .replace(INJECTED_MESSAGE_ID_SUFFIX_REGEX, "")
        .replace(HALLUCINATED_PARAMETER_SUFFIX_REGEX, "")
    return withoutKnownSuffixes
        .replace(DCP_PAIRED_TAG_REGEX, "")
        .replace(DCP_UNPAIRED_TAG_REGEX, "")
        .replace(DEGENERATE_TAG_DEBRIS_REGEX, "")
}

export const stripHallucinations = (messages: WithParts[], format: IdFormat = "xml"): void => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                part.text = stripHallucinationsFromString(part.text, format)
            }

            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                part.state.output = stripHallucinationsFromString(part.state.output, format)
            }
        }
    }
}
