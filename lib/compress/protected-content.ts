import type { ProtectedContent, SessionState } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { isToolProtected } from "../protected-patterns"
import {
    buildSubagentResultText,
    getSubAgentId,
    mergeSubagentResult,
} from "../subagents/subagent-results"
import { fetchSessionMessages } from "./search"
import type { SearchContext, SelectionResolution } from "./types"

export interface ProtectedContentResult {
    summaryText: string
    protectedContent: ProtectedContent[]
}

const USER_HEADING = "The following user messages were sent in this conversation verbatim:"
const PROMPT_HEADING =
    "The following protected prompt information was included in this conversation verbatim:"
const TOOL_HEADING = "The following protected tools were used in this conversation as well:"
const PREVIOUSLY_COMPRESSED_HEADING =
    "The following previously compressed summaries were also part of this conversation section:"

export const PROTECTED_SECTION_HEADINGS = [USER_HEADING, PROMPT_HEADING, TOOL_HEADING]

const EXPLICIT_PROTECTED_HEADINGS = [
    { kind: "user" as const, heading: USER_HEADING },
    { kind: "prompt" as const, heading: PROMPT_HEADING },
    { kind: "tool" as const, heading: TOOL_HEADING },
]

/**
 * Parse explicit protected sections (user messages, prompt info, tool outputs)
 * from a stored block summary. Stops at the `previously compressed summaries`
 * heading: that section is a nested tail that must never be copied forward.
 */
export function parseProtectedContentFromSummary(summary: string): ProtectedContent[] {
    if (!summary || typeof summary !== "string") {
        return []
    }

    const entries: ProtectedContent[] = []
    const positions: Array<{ kind: ProtectedContent["kind"]; heading: string; index: number }> = []

    for (const candidate of EXPLICIT_PROTECTED_HEADINGS) {
        let searchFrom = 0
        while (searchFrom < summary.length) {
            const index = summary.indexOf(candidate.heading, searchFrom)
            if (index === -1) {
                break
            }
            positions.push({ kind: candidate.kind, heading: candidate.heading, index })
            searchFrom = index + candidate.heading.length
        }
    }

    const previouslyCompressedIndex = summary.indexOf(PREVIOUSLY_COMPRESSED_HEADING)

    positions.sort((a, b) => a.index - b.index)
    for (let i = 0; i < positions.length; i++) {
        const current = positions[i]
        if (!current) {
            continue
        }
        const start = current.index + current.heading.length
        const next = positions[i + 1]
        let end = next ? next.index : summary.length
        if (previouslyCompressedIndex !== -1 && previouslyCompressedIndex > current.index) {
            end = Math.min(end, previouslyCompressedIndex)
        }

        let body = summary.slice(start, end).trim()
        if (!body) {
            continue
        }
        body = body.replace(/(?:\r?\n)+$/, "")

        if (current.kind === "tool") {
            const toolBlocks = body.split(/(?=### Tool:)/)
            for (const block of toolBlocks) {
                const trimmed = block.trim()
                if (trimmed) {
                    entries.push({ kind: "tool", text: trimmed })
                }
            }
        } else {
            entries.push({ kind: current.kind, text: body })
        }
    }

    return entries
}

function dedupeProtectedEntries(entries: ProtectedContent[]): ProtectedContent[] {
    const seen = new Set<string>()
    const result: ProtectedContent[] = []
    for (const entry of entries) {
        const key = `${entry.kind}:${entry.text}`
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        result.push(entry)
    }
    return result
}

/**
 * Render structured protected content back into the inline summary sections.
 * Preserves the canonical heading order (user, prompt, tool).
 */
export function renderProtectedContent(entries: ProtectedContent[]): string {
    const deduped = dedupeProtectedEntries(entries)
    if (deduped.length === 0) {
        return ""
    }

    const users = deduped.filter((entry) => entry.kind === "user")
    const prompts = deduped.filter((entry) => entry.kind === "prompt")
    const tools = deduped.filter((entry) => entry.kind === "tool")

    const sections: string[] = []
    if (users.length > 0) {
        sections.push(USER_HEADING + users.map((entry) => `\n${entry.text}`).join(""))
    }
    if (prompts.length > 0) {
        sections.push(PROMPT_HEADING + prompts.map((entry) => `\n${entry.text}`).join(""))
    }
    if (tools.length > 0) {
        sections.push(TOOL_HEADING + tools.map((entry) => `\n${entry.text}`).join(""))
    }

    return sections.join("\n\n")
}

/**
 * Return the structured protected content carried by a block. Prefers the
 * explicit `protectedContent` field; falls back to parsing the stored summary
 * (migration path for blocks created before this field existed).
 */
export function getBlockProtectedContent(block: {
    protectedContent?: ProtectedContent[]
    summary: string
}): ProtectedContent[] {
    if (Array.isArray(block.protectedContent) && block.protectedContent.length > 0) {
        return dedupeProtectedEntries(block.protectedContent)
    }
    return dedupeProtectedEntries(parseProtectedContentFromSummary(block.summary))
}

export function appendProtectedUserMessages(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): ProtectedContentResult {
    if (!enabled) {
        return { summaryText: summary, protectedContent: [] }
    }

    const userTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                userTexts.push(part.text)
                break
            }
        }
    }

    if (userTexts.length === 0) {
        return { summaryText: summary, protectedContent: [] }
    }

    const heading = "\n\n" + USER_HEADING
    const body = userTexts.map((text) => `\n${text}`).join("")
    return {
        summaryText: summary + heading + body,
        protectedContent: userTexts.map((text) => ({ kind: "user", text })),
    }
}

export function appendProtectedPromptInfo(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): ProtectedContentResult {
    if (!enabled) {
        return { summaryText: summary, protectedContent: [] }
    }

    const protectedTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "text" || typeof part.text !== "string") continue

            protectedTexts.push(...extractProtectedPromptInfo(part.text))
        }
    }

    if (protectedTexts.length === 0) {
        return { summaryText: summary, protectedContent: [] }
    }

    const heading = "\n\n" + PROMPT_HEADING
    const body = protectedTexts.map((text) => `\n${text}`).join("")
    return {
        summaryText: summary + heading + body,
        protectedContent: protectedTexts.map((text) => ({ kind: "prompt", text })),
    }
}

export function extractProtectedPromptInfo(text: string): string[] {
    const protectedTexts: string[] = []
    const protectTagRegex = /<protect>([\s\S]*?)<\/protect>/gi

    for (const match of text.matchAll(protectTagRegex)) {
        const protectedText = match[1]?.trim()
        if (protectedText) {
            protectedTexts.push(protectedText)
        }
    }

    return protectedTexts
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    allowSubAgents: boolean,
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): Promise<ProtectedContentResult> {
    const protectedOutputs: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                if (
                    isToolProtected(
                        part.tool,
                        part.state.input,
                        protectedTools,
                        protectedFilePatterns,
                        "metadata" in part.state ? part.state.metadata : undefined,
                    )
                ) {
                    const title = `Tool: ${part.tool}`
                    let output = ""

                    if (part.state?.status === "completed" && part.state?.output) {
                        output =
                            typeof part.state.output === "string"
                                ? part.state.output
                                : JSON.stringify(part.state.output)
                    }

                    if (
                        allowSubAgents &&
                        (part.tool === "task" || part.tool === "subagent") &&
                        part.state?.status === "completed" &&
                        typeof part.state?.output === "string"
                    ) {
                        const cachedSubAgentResult = state.subAgentResultCache.get(part.callID)

                        if (cachedSubAgentResult !== undefined) {
                            if (cachedSubAgentResult) {
                                output = mergeSubagentResult(
                                    part.state.output,
                                    cachedSubAgentResult,
                                )
                            }
                        } else {
                            const subAgentSessionId = getSubAgentId(part)
                            if (subAgentSessionId) {
                                let subAgentResultText = ""
                                try {
                                    const subAgentMessages = await fetchSessionMessages(
                                        client,
                                        subAgentSessionId,
                                    )
                                    subAgentResultText = buildSubagentResultText(subAgentMessages)
                                } catch {
                                    subAgentResultText = ""
                                }

                                if (subAgentResultText) {
                                    state.subAgentResultCache.set(part.callID, subAgentResultText)
                                    output = mergeSubagentResult(
                                        part.state.output,
                                        subAgentResultText,
                                    )
                                }
                            }
                        }
                    }

                    if (output) {
                        protectedOutputs.push(`### ${title}\n${output}`)
                    }
                }
            }
        }
    }

    if (protectedOutputs.length === 0) {
        return { summaryText: summary, protectedContent: [] }
    }

    const heading = "\n\n" + TOOL_HEADING
    const body = protectedOutputs.map((output) => `\n${output}`).join("")
    return {
        summaryText: summary + heading + body,
        protectedContent: protectedOutputs.map((output) => ({ kind: "tool", text: output })),
    }
}
