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
        // Skip all DCP processing for subagent sessions
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

                // Try each format handler in order
                // OpenAI Chat Completions & Anthropic style (body.messages)
                if (body.messages && Array.isArray(body.messages)) {
                    const result = await handleOpenAIChatAndAnthropic(body, ctx, inputUrl)
                    if (result.modified) {
                        modified = true
                    }
                }

                // Google/Gemini style (body.contents)
                if (body.contents && Array.isArray(body.contents)) {
                    const result = await handleGemini(body, ctx, inputUrl)
                    if (result.modified) {
                        modified = true
                    }
                }

                // OpenAI Responses API style (body.input)
                if (body.input && Array.isArray(body.input)) {
                    const result = await handleOpenAIResponses(body, ctx, inputUrl)
                    if (result.modified) {
                        modified = true
                    }
                }

                // Run strategies after handlers have populated toolParameters cache
                const sessionId = state.lastSeenSessionId
                if (sessionId && state.toolParameters.size > 0) {
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
                            // Normalize to lowercase to match janitor's ID normalization
                            const normalizedIds = result.prunedIds.map(id => id.toLowerCase())
                            state.prunedIds.set(sessionId, [...new Set([...alreadyPruned, ...normalizedIds])])

                            // Track GC activity for the next notification
                            accumulateGCStats(state, sessionId, result.prunedIds, body, logger)
                        }
                    }
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
