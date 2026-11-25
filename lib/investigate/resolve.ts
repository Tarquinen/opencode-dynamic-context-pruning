import type { CompressionBlock, SessionState, WithParts } from "../state"
import { formatBlockRef, parseBlockRef } from "../message-ids"
import { countTokens, extractCompletedToolOutput } from "../token-utils"

export interface ResolvedSlice {
    block: CompressionBlock
    blockRef: string
    messages: WithParts[]
}

export function parseBlockIdArg(arg: string): number | null {
    const normalized = arg.trim().toLowerCase()
    const blockRef = parseBlockRef(normalized) ?? parseBlockRef(normalized, "compact")
    if (blockRef !== null) {
        return blockRef
    }
    if (!/^[1-9]\d*$/.test(normalized)) {
        return null
    }
    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function resolveBlockSlice(
    state: SessionState,
    rawMessages: WithParts[],
    blockId: number,
): ResolvedSlice {
    const block = state.prune.messages.blocksById.get(blockId)
    if (!block) {
        throw new Error(`Compression block ${blockId} does not exist in this session.`)
    }

    const ids =
        block.effectiveMessageIds.length > 0 ? block.effectiveMessageIds : block.directMessageIds
    const idSet = new Set<string>(ids)
    const messages = rawMessages.filter((message) => idSet.has(message.info.id))

    return {
        block,
        blockRef: formatBlockRef(blockId, state.idFormat),
        messages,
    }
}

export function serializeMessages(messages: WithParts[]): string {
    const blocks: string[] = []
    for (const message of messages) {
        const role = message.info.role ?? "message"
        const parts = Array.isArray(message.parts) ? message.parts : []
        const chunks: string[] = []
        for (const part of parts) {
            if (part.type === "text") {
                const text = (part as { text?: string }).text
                if (typeof text === "string" && text.trim().length > 0) {
                    chunks.push(text)
                }
            } else if (part.type === "tool") {
                const toolPart = part as any
                const name = toolPart.tool ?? "tool"
                const input = toolPart.state?.input
                const output = extractCompletedToolOutput(toolPart)
                let chunk = `[tool call: ${name}]`
                if (input !== undefined) {
                    chunk += `\n(input: ${typeof input === "string" ? input : JSON.stringify(input)})`
                }
                if (output !== undefined) {
                    chunk += `\n(output: ${output})`
                }
                chunks.push(chunk)
            }
        }
        if (chunks.length === 0) {
            continue
        }
        blocks.push(`### ${role}\n${chunks.join("\n")}`)
    }
    return blocks.join("\n\n")
}

export function truncateMessages(
    messages: WithParts[],
    maxTokens?: number,
): { text: string; truncated: boolean } {
    const full = serializeMessages(messages)
    if (!Number.isFinite(maxTokens) || (maxTokens ?? 0) <= 0 || countTokens(full) <= maxTokens!) {
        return { text: full, truncated: false }
    }
    for (let i = 1; i < messages.length; i++) {
        const text = serializeMessages(messages.slice(i))
        if (countTokens(text) <= maxTokens!) {
            return { text, truncated: true }
        }
    }
    return { text: serializeMessages(messages.slice(-1)), truncated: true }
}
