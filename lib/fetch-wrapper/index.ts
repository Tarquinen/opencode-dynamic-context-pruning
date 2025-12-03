import type { PluginState } from "../state"
import type { Logger } from "../logger"
import type { FetchHandlerContext, SynthPrompts } from "./types"
import type { ToolTracker } from "../api-formats/synth-instruction"
import type { PluginConfig } from "../config"
import { handleOpenAIChatAndAnthropic } from "./openai-chat"
import { handleGemini } from "./gemini"
import { handleOpenAIResponses } from "./openai-responses"
import { runStrategies } from "../core/strategies"
import { accumulateGCStats } from "./gc-tracker"
import { trimToolParametersCache } from "../state/tool-cache"

export type { FetchHandlerContext, FetchHandlerResult, SynthPrompts } from "./types"

/**
 * Creates a wrapped global fetch that intercepts API calls and performs
 * context pruning on tool outputs that have been marked for removal.
 * 
 * Supports four API formats:
 * 1. OpenAI Chat Completions (body.messages with role='tool')
 * 2. Anthropic (body.messages with role='user' containing tool_result)
 * 3. Google/Gemini (body.contents with functionResponse parts)
 * 4. OpenAI Responses API (body.input with function_call_output items)
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

                // Capture tool IDs before handlers run to track what gets cached this request
                const toolIdsBefore = new Set(state.toolParameters.keys())

                // Try each format handler - mutually exclusive to avoid double-processing
                // OpenAI Responses API style (body.input) - check first as it may also have messages
                if (body.input && Array.isArray(body.input)) {
                    const result = await handleOpenAIResponses(body, ctx, inputUrl)
                    if (result.modified) {
                        modified = true
                    }
                }
                // OpenAI Chat Completions & Anthropic style (body.messages)
                else if (body.messages && Array.isArray(body.messages)) {
                    const result = await handleOpenAIChatAndAnthropic(body, ctx, inputUrl)
                    if (result.modified) {
                        modified = true
                    }
                }
                // Google/Gemini style (body.contents)
                else if (body.contents && Array.isArray(body.contents)) {
                    const result = await handleGemini(body, ctx, inputUrl)
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
