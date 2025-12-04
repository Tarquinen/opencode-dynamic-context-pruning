import type { PluginState } from "../state"
import type { Logger } from "../logger"
import type { FetchHandlerContext, SynthPrompts } from "./types"
import type { ToolTracker } from "../api-formats/synth-instruction"
import type { PluginConfig } from "../config"
import { openaiChatFormat, openaiResponsesFormat, geminiFormat, bedrockFormat } from "./formats"
import { handleFormat } from "./handler"
import { runStrategies } from "../core/strategies"
import { accumulateGCStats } from "./gc-tracker"
import { trimToolParametersCache } from "../state/tool-cache"

export type { FetchHandlerContext, FetchHandlerResult, SynthPrompts } from "./types"

/**
 * Creates a wrapped global fetch that intercepts API calls and performs
 * context pruning on tool outputs that have been marked for removal.
 * 
 * Supports five API formats:
 * 1. OpenAI Chat Completions (body.messages with role='tool')
 * 2. Anthropic (body.messages with role='user' containing tool_result)
 * 3. Google/Gemini (body.contents with functionResponse parts)
 * 4. OpenAI Responses API (body.input with function_call_output items)
 * 5. AWS Bedrock Converse API (body.system + body.messages with toolResult blocks)
 */
export function installFetchWrapper(
    state: PluginState,
    logger: Logger,
    client: any,
    config: PluginConfig,
    toolTracker: ToolTracker,
    prompts: SynthPrompts
): () => void {
    const originalGlobalFetch = globalThis.fetch

    const ctx: FetchHandlerContext = {
        state,
        logger,
        client,
        config,
        toolTracker,
        prompts
    }

    globalThis.fetch = async (input: any, init?: any) => {
        if (state.lastSeenSessionId && state.subagentSessions.has(state.lastSeenSessionId)) {
            logger.debug("fetch-wrapper", "Skipping DCP processing for subagent session", {
                sessionId: state.lastSeenSessionId.substring(0, 8)
            })
            return originalGlobalFetch(input, init)
        }

        if (init?.body && typeof init.body === 'string') {
            try {
                const body = JSON.parse(init.body)
                const inputUrl = typeof input === 'string' ? input : 'URL object'
                let modified = false

                const toolIdsBefore = new Set(state.toolParameters.keys())

                // Mutually exclusive format handlers
                // Note: bedrockFormat must be checked before openaiChatFormat since both have messages[]
                // but Bedrock has distinguishing system[] array and inferenceConfig
                if (openaiResponsesFormat.detect(body)) {
                    const result = await handleFormat(body, ctx, inputUrl, openaiResponsesFormat)
                    if (result.modified) {
                        modified = true
                    }
                }
                else if (bedrockFormat.detect(body)) {
                    const result = await handleFormat(body, ctx, inputUrl, bedrockFormat)
                    if (result.modified) {
                        modified = true
                    }
                }
                else if (openaiChatFormat.detect(body)) {
                    const result = await handleFormat(body, ctx, inputUrl, openaiChatFormat)
                    if (result.modified) {
                        modified = true
                    }
                }
                else if (geminiFormat.detect(body)) {
                    const result = await handleFormat(body, ctx, inputUrl, geminiFormat)
                    if (result.modified) {
                        modified = true
                    }
                }

                const sessionId = state.lastSeenSessionId
                const toolIdsAfter = Array.from(state.toolParameters.keys())
                const newToolsCached = toolIdsAfter.filter(id => !toolIdsBefore.has(id)).length > 0

                if (sessionId && newToolsCached && state.toolParameters.size > 0) {
                    const toolIds = Array.from(state.toolParameters.keys())
                    const alreadyPruned = state.prunedIds.get(sessionId) ?? []
                    const alreadyPrunedLower = new Set(alreadyPruned.map(id => id.toLowerCase()))
                    const unpruned = toolIds.filter(id => !alreadyPrunedLower.has(id.toLowerCase()))
                    if (unpruned.length > 1) {
                        const result = runStrategies(
                            state.toolParameters,
                            unpruned,
                            config.protectedTools
                        )
                        if (result.prunedIds.length > 0) {
                            const normalizedIds = result.prunedIds.map(id => id.toLowerCase())
                            state.prunedIds.set(sessionId, [...new Set([...alreadyPruned, ...normalizedIds])])
                            accumulateGCStats(state, sessionId, result.prunedIds, body, logger)
                        }
                    }

                    trimToolParametersCache(state)
                }

                if (modified) {
                    init.body = JSON.stringify(body)
                }
            } catch (e) {
            }
        }

        return originalGlobalFetch(input, init)
    }

    return () => {
        globalThis.fetch = originalGlobalFetch
    }
}
