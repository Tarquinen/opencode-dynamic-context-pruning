import type { FetchHandlerContext, FetchHandlerResult } from "./types"
import {
    PRUNED_CONTENT_MESSAGE,
    getAllPrunedIds,
    fetchSessionMessages,
    getMostRecentActiveSession
} from "./types"
import { cacheToolParametersFromInput } from "../tool-cache"
import { injectNudgeResponses, injectSynthResponses } from "../synth-instruction"

/**
 * Handles OpenAI Responses API format (body.input array with function_call_output items).
 * Used by GPT-5 models via sdk.responses().
 */
export async function handleOpenAIResponses(
    body: any,
    ctx: FetchHandlerContext,
    inputUrl: string
): Promise<FetchHandlerResult> {
    if (!body.input || !Array.isArray(body.input)) {
        return { modified: false, body }
    }

    // Cache tool parameters from input
    cacheToolParametersFromInput(body.input, ctx.state)

    let modified = false

    // Inject synthetic instructions if onTool strategies are enabled
    if (ctx.config.strategies.onTool.length > 0) {
        // Inject periodic nudge based on tool result count
        if (ctx.config.nudge_freq > 0) {
            if (injectNudgeResponses(body.input, ctx.toolTracker, ctx.prompts.nudgeInstruction, ctx.config.nudge_freq)) {
                ctx.logger.info("fetch", "Injected nudge instruction (Responses API)")
                modified = true
            }
        }

        // Inject synthetic instruction into last user message
        if (injectSynthResponses(body.input, ctx.prompts.synthInstruction)) {
            ctx.logger.info("fetch", "Injected synthetic instruction (Responses API)")
            modified = true
        }
    }

    // Check for function_call_output items
    const functionOutputs = body.input.filter((item: any) => item.type === 'function_call_output')

    if (functionOutputs.length === 0) {
        return { modified, body }
    }

    const { allSessions, allPrunedIds } = await getAllPrunedIds(ctx.client, ctx.state)

    if (allPrunedIds.size === 0) {
        return { modified, body }
    }

    let replacedCount = 0

    body.input = body.input.map((item: any) => {
        if (item.type === 'function_call_output' && allPrunedIds.has(item.call_id?.toLowerCase())) {
            replacedCount++
            return {
                ...item,
                output: PRUNED_CONTENT_MESSAGE
            }
        }
        return item
    })

    if (replacedCount > 0) {
        ctx.logger.info("fetch", "Replaced pruned tool outputs (Responses API)", {
            replaced: replacedCount,
            total: functionOutputs.length
        })

        if (ctx.logger.enabled) {
            const mostRecentSession = getMostRecentActiveSession(allSessions)
            const sessionMessages = mostRecentSession
                ? await fetchSessionMessages(ctx.client, mostRecentSession.id)
                : undefined

            await ctx.logger.saveWrappedContext(
                "global",
                body.input,
                {
                    url: inputUrl,
                    replacedCount,
                    totalItems: body.input.length,
                    format: 'openai-responses-api'
                },
                sessionMessages
            )
        }

        return { modified: true, body }
    }

    return { modified, body }
}
