import type { FetchHandlerContext, FetchHandlerResult } from "./types"
import {
    PRUNED_CONTENT_MESSAGE,
    getAllPrunedIds,
    fetchSessionMessages
} from "./types"
import { injectNudgeGemini, injectSynthGemini } from "../synth-instruction"

/**
 * Handles Google/Gemini format (body.contents array with functionResponse parts).
 * Uses position-based correlation since Google's native format doesn't include tool call IDs.
 */
export async function handleGemini(
    body: any,
    ctx: FetchHandlerContext,
    inputUrl: string
): Promise<FetchHandlerResult> {
    if (!body.contents || !Array.isArray(body.contents)) {
        return { modified: false, body }
    }

    let modified = false

    // Inject synthetic instructions if onTool strategies are enabled
    if (ctx.config.strategies.onTool.length > 0) {
        // Inject periodic nudge based on tool result count
        if (ctx.config.nudge_freq > 0) {
            if (injectNudgeGemini(body.contents, ctx.toolTracker, ctx.prompts.nudgeInstruction, ctx.config.nudge_freq)) {
                ctx.logger.info("fetch", "Injected nudge instruction (Gemini)")
                modified = true
            }
        }

        // Inject synthetic instruction into last user content
        if (injectSynthGemini(body.contents, ctx.prompts.synthInstruction)) {
            ctx.logger.info("fetch", "Injected synthetic instruction (Gemini)")
            modified = true
        }
    }

    // Check for functionResponse parts in any content item
    const hasFunctionResponses = body.contents.some((content: any) =>
        Array.isArray(content.parts) &&
        content.parts.some((part: any) => part.functionResponse)
    )

    if (!hasFunctionResponses) {
        return { modified, body }
    }

    const { allSessions, allPrunedIds } = await getAllPrunedIds(ctx.client, ctx.state)

    if (allPrunedIds.size === 0) {
        return { modified, body }
    }

    // Find the active session to get the position mapping
    const activeSessions = allSessions.data?.filter((s: any) => !s.parentID) || []
    let positionMapping: Map<string, string> | undefined

    for (const session of activeSessions) {
        const mapping = ctx.state.googleToolCallMapping.get(session.id)
        if (mapping && mapping.size > 0) {
            positionMapping = mapping
            break
        }
    }

    if (!positionMapping) {
        ctx.logger.info("fetch", "No Google tool call mapping found, skipping pruning for Gemini format")
        return { modified, body }
    }

    // Build position counters to track occurrence of each tool name
    const toolPositionCounters = new Map<string, number>()
    let replacedCount = 0
    let totalFunctionResponses = 0

    body.contents = body.contents.map((content: any) => {
        if (!Array.isArray(content.parts)) return content

        let contentModified = false
        const newParts = content.parts.map((part: any) => {
            if (part.functionResponse) {
                totalFunctionResponses++
                const funcName = part.functionResponse.name?.toLowerCase()

                if (funcName) {
                    // Get current position for this tool name and increment counter
                    const currentIndex = toolPositionCounters.get(funcName) || 0
                    toolPositionCounters.set(funcName, currentIndex + 1)

                    // Look up the tool call ID using position
                    const positionKey = `${funcName}:${currentIndex}`
                    const toolCallId = positionMapping!.get(positionKey)

                    if (toolCallId && allPrunedIds.has(toolCallId)) {
                        contentModified = true
                        replacedCount++
                        // Preserve thoughtSignature if present (required for Gemini 3 Pro)
                        // response must be a Struct (object), not a plain string
                        return {
                            ...part,
                            functionResponse: {
                                ...part.functionResponse,
                                response: {
                                    name: part.functionResponse.name,
                                    content: PRUNED_CONTENT_MESSAGE
                                }
                            }
                        }
                    }
                }
            }
            return part
        })

        if (contentModified) {
            return { ...content, parts: newParts }
        }
        return content
    })

    if (replacedCount > 0) {
        ctx.logger.info("fetch", "Replaced pruned tool outputs (Google/Gemini)", {
            replaced: replacedCount,
            total: totalFunctionResponses
        })

        if (ctx.logger.enabled) {
            let sessionMessages: any[] | undefined
            if (activeSessions.length > 0) {
                const mostRecentSession = activeSessions[0]
                sessionMessages = await fetchSessionMessages(ctx.client, mostRecentSession.id)
            }

            await ctx.logger.saveWrappedContext(
                "global",
                body.contents,
                {
                    url: inputUrl,
                    replacedCount,
                    totalContents: body.contents.length,
                    format: 'google-gemini'
                },
                sessionMessages
            )
        }

        return { modified: true, body }
    }

    return { modified, body }
}
