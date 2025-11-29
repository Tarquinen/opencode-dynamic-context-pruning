import type { PluginState } from "../state"
import type { Logger } from "../logger"
import type { FetchHandlerContext, SynthPrompts } from "./types"
import type { ToolTracker } from "../synth-instruction"
import type { PluginConfig } from "../config"
import { handleOpenAIChatAndAnthropic } from "./openai-chat"
import { handleGemini } from "./gemini"
import { handleOpenAIResponses } from "./openai-responses"

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

                if (modified) {
                    init.body = JSON.stringify(body)
                }
            } catch (e) {
                // Silently ignore parsing errors - pass through to original fetch
            }
        }

        return originalGlobalFetch(input, init)
    }

    // Return cleanup function to restore original fetch
    return () => {
        globalThis.fetch = originalGlobalFetch
    }
}
