import type { FetchHandlerContext, FetchHandlerResult } from "./types"
import {
    PRUNED_CONTENT_MESSAGE,
    getAllPrunedIds,
    fetchSessionMessages,
    getMostRecentActiveSession
} from "./types"
import { cacheToolParametersFromMessages } from "../tool-cache"
import { injectNudge, injectSynth } from "../synth-instruction"

/**
 * Handles OpenAI Chat Completions format (body.messages with role='tool').
 * Also handles Anthropic format (role='user' with tool_result content parts).
 */
export async function handleOpenAIChatAndAnthropic(
    body: any,
    ctx: FetchHandlerContext,
    inputUrl: string
): Promise<FetchHandlerResult> {
    if (!body.messages || !Array.isArray(body.messages)) {
        return { modified: false, body }
    }

    // Cache tool parameters from messages
    cacheToolParametersFromMessages(body.messages, ctx.state)

    let modified = false

    // Inject synthetic instructions if onTool strategies are enabled
    if (ctx.config.strategies.onTool.length > 0) {
        // Inject periodic nudge based on tool result count
        if (ctx.config.nudge_freq > 0) {
            if (injectNudge(body.messages, ctx.toolTracker, ctx.prompts.nudgeInstruction, ctx.config.nudge_freq)) {
                ctx.logger.info("fetch", "Injected nudge instruction")
                modified = true
            }
        }

        // Inject synthetic instruction into last user message
        if (injectSynth(body.messages, ctx.prompts.synthInstruction)) {
            ctx.logger.info("fetch", "Injected synthetic instruction")
            modified = true
        }
    }

    // Check for tool messages in both formats:
    // 1. OpenAI style: role === 'tool'
    // 2. Anthropic style: role === 'user' with content containing tool_result
    const toolMessages = body.messages.filter((m: any) => {
        if (m.role === 'tool') return true
        if (m.role === 'user' && Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === 'tool_result') return true
            }
        }
        return false
    })

    const { allSessions, allPrunedIds } = await getAllPrunedIds(ctx.client, ctx.state)

    if (toolMessages.length === 0 || allPrunedIds.size === 0) {
        return { modified, body }
    }

    let replacedCount = 0

    body.messages = body.messages.map((m: any) => {
        // OpenAI style: role === 'tool' with tool_call_id
        if (m.role === 'tool' && allPrunedIds.has(m.tool_call_id?.toLowerCase())) {
            replacedCount++
            return {
                ...m,
                content: PRUNED_CONTENT_MESSAGE
            }
        }

        // Anthropic style: role === 'user' with content array containing tool_result
        if (m.role === 'user' && Array.isArray(m.content)) {
            let messageModified = false
            const newContent = m.content.map((part: any) => {
                if (part.type === 'tool_result' && allPrunedIds.has(part.tool_use_id?.toLowerCase())) {
                    messageModified = true
                    replacedCount++
                    return {
                        ...part,
                        content: PRUNED_CONTENT_MESSAGE
                    }
                }
                return part
            })
            if (messageModified) {
                return { ...m, content: newContent }
            }
        }

        return m
    })

    if (replacedCount > 0) {
        ctx.logger.info("fetch", "Replaced pruned tool outputs", {
            replaced: replacedCount,
            total: toolMessages.length
        })

        if (ctx.logger.enabled) {
            const mostRecentSession = getMostRecentActiveSession(allSessions)
            const sessionMessages = mostRecentSession
                ? await fetchSessionMessages(ctx.client, mostRecentSession.id)
                : undefined

            await ctx.logger.saveWrappedContext(
                "global",
                body.messages,
                {
                    url: inputUrl,
                    replacedCount,
                    totalMessages: body.messages.length
                },
                sessionMessages
            )
        }

        return { modified: true, body }
    }

    return { modified, body }
}
