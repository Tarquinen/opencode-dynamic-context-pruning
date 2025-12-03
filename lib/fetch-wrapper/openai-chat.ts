import type { FetchHandlerContext, FetchHandlerResult } from "./types"
import {
    PRUNED_CONTENT_MESSAGE,
    getAllPrunedIds,
    fetchSessionMessages,
    getMostRecentActiveSession
} from "./types"
import { cacheToolParametersFromMessages } from "../state/tool-cache"
import { injectSynth, trackNewToolResults } from "../api-formats/synth-instruction"
import { buildPrunableToolsList, buildEndInjection, injectPrunableList } from "../api-formats/prunable-list"

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

    // Cache tool parameters from messages (OpenAI and Anthropic formats)
    cacheToolParametersFromMessages(body.messages, ctx.state, ctx.logger)

    let modified = false

    // Inject synthetic instructions if onTool strategies are enabled
    if (ctx.config.strategies.onTool.length > 0) {
        // Inject base synthetic instructions (appended to last user message)
        if (injectSynth(body.messages, ctx.prompts.synthInstruction, ctx.prompts.nudgeInstruction)) {
            modified = true
        }

        // Build and inject prunable tools list at the end
        const sessionId = ctx.state.lastSeenSessionId
        if (sessionId) {
            const toolIds = Array.from(ctx.state.toolParameters.keys())
            const alreadyPruned = ctx.state.prunedIds.get(sessionId) ?? []
            const alreadyPrunedLower = new Set(alreadyPruned.map(id => id.toLowerCase()))
            const unprunedIds = toolIds.filter(id => !alreadyPrunedLower.has(id.toLowerCase()))

            const { list: prunableList, numericIds } = buildPrunableToolsList(
                sessionId,
                unprunedIds,
                ctx.state.toolParameters,
                ctx.config.protectedTools
            )

            if (prunableList) {
                // Track new tool results and check if nudge threshold is met
                const protectedSet = new Set(ctx.config.protectedTools)
                trackNewToolResults(body.messages, ctx.toolTracker, protectedSet)
                const includeNudge = ctx.config.nudge_freq > 0 && ctx.toolTracker.toolResultCount > ctx.config.nudge_freq

                const endInjection = buildEndInjection(prunableList, includeNudge)
                if (injectPrunableList(body.messages, endInjection)) {
                    ctx.logger.debug("fetch", "Injected prunable tools list", {
                        ids: numericIds,
                        nudge: includeNudge,
                        toolsSincePrune: ctx.toolTracker.toolResultCount
                    })
                    modified = true
                }
            }
        }
    }

    // Check for tool messages in both formats:
    // 1. OpenAI style: role === 'tool'
    // 2. Anthropic style: role === 'user' with content containing tool_result
    const protectedToolsLower = new Set(ctx.config.protectedTools.map(t => t.toLowerCase()))
    
    // Count all tool messages
    const toolMessages = body.messages.filter((m: any) => {
        if (m.role === 'tool') return true
        if (m.role === 'user' && Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === 'tool_result') return true
            }
        }
        return false
    })
    
    // Count only prunable (non-protected) tool messages for the total
    let prunableToolCount = 0
    for (const m of body.messages) {
        if (m.role === 'tool') {
            // Get tool name from cached metadata
            const toolId = m.tool_call_id?.toLowerCase()
            const metadata = toolId ? ctx.state.toolParameters.get(toolId) : undefined
            if (!metadata || !protectedToolsLower.has(metadata.tool.toLowerCase())) {
                prunableToolCount++
            }
        } else if (m.role === 'user' && Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === 'tool_result') {
                    const toolId = part.tool_use_id?.toLowerCase()
                    const metadata = toolId ? ctx.state.toolParameters.get(toolId) : undefined
                    if (!metadata || !protectedToolsLower.has(metadata.tool.toLowerCase())) {
                        prunableToolCount++
                    }
                }
            }
        }
    }

    const { allSessions, allPrunedIds } = await getAllPrunedIds(ctx.client, ctx.state, ctx.logger)

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
            total: prunableToolCount
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
