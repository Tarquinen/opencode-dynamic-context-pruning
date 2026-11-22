/**
 * DCP Context Command
 * Shows a visual breakdown of token usage in the current session.
 *
 * TOKEN CALCULATION STRATEGY
 * ==========================
 * We minimize tokenizer estimation by leveraging API-reported values wherever possible.
 *
 * WHAT WE GET FROM THE API (exact):
 *   - tokens.input    : Input tokens for each assistant response
 *   - tokens.output   : Output tokens generated (includes text + tool calls)
 *   - tokens.reasoning: Reasoning tokens used
 *   - tokens.cache    : Cache read/write tokens
 *
 * HOW WE CALCULATE EACH CATEGORY:
 *
 *   SYSTEM = firstAssistant.input + cache.read + cache.write - tokenizer(firstUserMessage)
 *            The first response's total input (input + cache.read + cache.write)
 *            contains system + first user message. On the first request of a
 *            session, the system prompt appears in cache.write (cache creation),
 *            not cache.read.
 *
 *   TOOLS  = tokenizer(toolInputs + toolOutputs) - prunedTokens
 *            We must tokenize tools anyway for pruning decisions.
 *
 *   USER   = tokenizer(all user messages)
 *            User messages are typically small, so estimation is acceptable.
 *
 *   ASSISTANT = total - system - user - tools
 *               Calculated as residual. This absorbs:
 *               - Assistant text output tokens
 *               - Reasoning tokens (if persisted by the model)
 *               - Any estimation errors
 *
 *   TOTAL  = input + output + reasoning + cache.read + cache.write
 *            Matches opencode's UI display.
 *
 * WHY ASSISTANT IS THE RESIDUAL:
 *   If reasoning tokens persist in context (model-dependent), they semantically
 *   belong with "Assistant" since reasoning IS assistant-generated content.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { isIgnoredUserMessage } from "../messages/query"
import { isMessageCompacted } from "../state/utils"
import { countTokens, extractCompletedToolOutput, getCurrentParams } from "../token-utils"
import type { AssistantMessage, TextPart, ToolPart } from "@opencode-ai/sdk/v2"

export interface ContextCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

interface TokenBreakdown {
    system: number
    user: number
    assistant: number
    tools: number
    toolCount: number
    toolsInContextCount: number
    prunedTokens: number
    prunedToolCount: number
    prunedMessageCount: number
    total: number
}

export function analyzeContextTokens(state: SessionState, messages: WithParts[]): TokenBreakdown {
    const breakdown: TokenBreakdown = {
        system: 0,
        user: 0,
        assistant: 0,
        tools: 0,
        toolCount: 0,
        toolsInContextCount: 0,
        prunedTokens: state.stats.totalPruneTokens,
        prunedToolCount: 0,
        prunedMessageCount: 0,
        total: 0,
    }

    let firstAssistant: AssistantMessage | undefined
    for (const msg of messages) {
        if (msg.info.role === "assistant" && !isMessageCompacted(state, msg)) {
            const assistantInfo = msg.info as AssistantMessage
            if (
                assistantInfo.tokens?.input > 0 ||
                assistantInfo.tokens?.cache?.read > 0 ||
                assistantInfo.tokens?.cache?.write > 0
            ) {
                firstAssistant = assistantInfo
                break
            }
        }
    }

    let lastAssistant: AssistantMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant" && !isMessageCompacted(state, msg)) {
            const assistantInfo = msg.info as AssistantMessage
            if (assistantInfo.tokens?.output > 0) {
                lastAssistant = assistantInfo
                break
            }
        }
    }

    const apiInput = lastAssistant?.tokens?.input || 0
    const apiOutput = lastAssistant?.tokens?.output || 0
    const apiReasoning = lastAssistant?.tokens?.reasoning || 0
    const apiCacheRead = lastAssistant?.tokens?.cache?.read || 0
    const apiCacheWrite = lastAssistant?.tokens?.cache?.write || 0
    breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite

    const userTextParts: string[] = []
    const toolInputParts: string[] = []
    const toolOutputParts: string[] = []
    let firstUserText = ""
    let foundFirstUser = false
    const allToolIds = new Set<string>()
    const activeToolIds = new Set<string>()
    const prunedByMessageToolIds = new Set<string>()
    const allMessageIds = new Set<string>()

    for (const msg of messages) {
        allMessageIds.add(msg.info.id)
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const isCompacted = isMessageCompacted(state, msg)
        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        const isMessagePruned = !!pruneEntry && pruneEntry.activeBlockIds.length > 0
        const isIgnoredUser = isIgnoredUserMessage(msg)

        for (const part of parts) {
            if (part.type === "tool") {
                const toolPart = part as ToolPart
                if (toolPart.callID) {
                    allToolIds.add(toolPart.callID)
                    if (!isCompacted) {
                        activeToolIds.add(toolPart.callID)
                    }
                    if (isMessagePruned) {
                        prunedByMessageToolIds.add(toolPart.callID)
                    }
                }

                const isPruned = toolPart.callID && state.prune.tools.has(toolPart.callID)
                if (!isCompacted && !isPruned) {
                    if (toolPart.state?.input) {
                        const inputStr =
                            typeof toolPart.state.input === "string"
                                ? toolPart.state.input
                                : JSON.stringify(toolPart.state.input)
                        toolInputParts.push(inputStr)
                    }

                    const outputStr = extractCompletedToolOutput(toolPart)
                    if (outputStr !== undefined) {
                        toolOutputParts.push(outputStr)
                    }
                }
            } else if (
                part.type === "text" &&
                msg.info.role === "user" &&
                !isCompacted &&
                !isIgnoredUser
            ) {
                const textPart = part as TextPart
                const text = textPart.text || ""
                userTextParts.push(text)
                if (!foundFirstUser) {
                    firstUserText += text
                }
            }
        }

        if (msg.info.role === "user" && !isIgnoredUser && !foundFirstUser) {
            foundFirstUser = true
        }
    }

    const prunedByToolIds = new Set<string>()
    for (const id of allToolIds) {
        if (state.prune.tools.has(id)) {
            prunedByToolIds.add(id)
        }
    }

    const prunedToolIds = new Set<string>([...prunedByToolIds, ...prunedByMessageToolIds])
    const toolsInContextCount = [...activeToolIds].filter((id) => !prunedByToolIds.has(id)).length

    let prunedMessageCount = 0
    for (const [id, entry] of state.prune.messages.byMessageId) {
        if (allMessageIds.has(id) && entry.activeBlockIds.length > 0) {
            prunedMessageCount++
        }
    }

    breakdown.toolCount = allToolIds.size
    breakdown.toolsInContextCount = toolsInContextCount
    breakdown.prunedToolCount = prunedToolIds.size
    breakdown.prunedMessageCount = prunedMessageCount

    const firstUserTokens = countTokens(firstUserText)
    breakdown.user = countTokens(userTextParts.join("\n"))
    const toolInputTokens = countTokens(toolInputParts.join("\n"))
    const toolOutputTokens = countTokens(toolOutputParts.join("\n"))

    if (firstAssistant) {
        const firstInput =
            (firstAssistant.tokens?.input || 0) +
            (firstAssistant.tokens?.cache?.read || 0) +
            (firstAssistant.tokens?.cache?.write || 0)
        breakdown.system = Math.max(0, firstInput - firstUserTokens)
    }

    breakdown.tools = toolInputTokens + toolOutputTokens
    breakdown.assistant = Math.max(
        0,
        breakdown.total - breakdown.system - breakdown.user - breakdown.tools,
    )

    return breakdown
}

function createBar(value: number, maxValue: number, width: number, char: string = "█"): string {
    if (maxValue === 0) return ""
    const filled = Math.round((value / maxValue) * width)
    const bar = char.repeat(Math.max(0, filled))
    return bar
}

export function formatContextMessage(breakdown: TokenBreakdown): string {
    const lines: string[] = []
    const barWidth = 30

    const toolsLabel = `Tools (${breakdown.toolsInContextCount})`

    const categories = [
        { label: "System", value: breakdown.system, char: "█" },
        { label: "User", value: breakdown.user, char: "▓" },
        { label: "Assistant", value: breakdown.assistant, char: "▒" },
        { label: toolsLabel, value: breakdown.tools, char: "░" },
    ] as const

    const maxLabelLen = Math.max(...categories.map((c) => c.label.length))

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                  DCP Context Analysis                     │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Session Context Breakdown:")
    lines.push("─".repeat(60))
    lines.push("")

    for (const cat of categories) {
        const bar = createBar(cat.value, breakdown.total, barWidth, cat.char)
        const percentage =
            breakdown.total > 0 ? ((cat.value / breakdown.total) * 100).toFixed(1) : "0.0"
        const labelWithPct = `${cat.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `
        const valueStr = formatTokenCount(cat.value).padStart(13)
        lines.push(`${labelWithPct}│${bar.padEnd(barWidth)}│${valueStr}`)
    }

    lines.push("")
    lines.push("─".repeat(60))
    lines.push("")

    lines.push("Summary:")

    if (breakdown.prunedTokens > 0) {
        const withoutPruning = breakdown.total + breakdown.prunedTokens
        const pruned = []
        if (breakdown.prunedToolCount > 0) pruned.push(`${breakdown.prunedToolCount} tools`)
        if (breakdown.prunedMessageCount > 0)
            pruned.push(`${breakdown.prunedMessageCount} messages`)
        lines.push(
            `  Pruned:          ${pruned.join(", ")} (~${formatTokenCount(breakdown.prunedTokens)})`,
        )
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
        lines.push(`  Without DCP:     ~${formatTokenCount(withoutPruning)}`)
    } else {
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
    }

    lines.push("")

    return lines.join("\n")
}

export async function handleContextCommand(ctx: ContextCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const breakdown = analyzeContextTokens(state, messages)

    const message = formatContextMessage(breakdown)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)
}
