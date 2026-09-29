import type { PluginConfig } from "../config"
import type { WithParts } from "../state"
import { isMessageWithInfo } from "./shape"
import { isDcpChatText } from "../ui/utils"

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}

export {
    LEGACY_COMPRESS_TOOL_NAME,
    DEFAULT_COMPRESS_TOOL_NAME,
} from "../tool-name"
import { LEGACY_COMPRESS_TOOL_NAME, DEFAULT_COMPRESS_TOOL_NAME } from "../tool-name"

/**
 * True when a session message part belongs to DCP's compress tool. Accepts the
 * legacy "compress" name so parts recorded by older sessions keep resolving
 * after the tool was renamed (the sleev gateway shadows the name "compress" on
 * the wire, which is why DCP's tool now registers as "dcp_compress").
 */
export const isCompressToolPart = (part: any): boolean =>
    part?.type === "tool" &&
    (part.tool === LEGACY_COMPRESS_TOOL_NAME || part.tool === DEFAULT_COMPRESS_TOOL_NAME)

export const messageHasCompress = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            isCompressToolPart(part) &&
            (part as { state?: { status?: string } }).state?.status === "completed",
    )
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "user") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if ((part as any).ignored) {
            continue
        }
        // V2 hosts never strip `ignored` parts and the flag does not always
        // survive into the request view, so DCP chat notifications are also
        // recognized by their branded marker text.
        if (part.type === "text" && isDcpChatText(part.text)) {
            continue
        }
        return false
    }

    return true
}

export function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean {
    if (!isMessageWithInfo(message)) {
        return false
    }

    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages &&
        message.info.role === "user" &&
        !isIgnoredUserMessage(message)
    )
}
