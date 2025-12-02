import type { PluginState } from "./state"

/** Maximum number of tool parameters to cache to prevent unbounded memory growth */
const MAX_TOOL_PARAMETERS_CACHE_SIZE = 500

/**
 * Ensures the toolParameters cache doesn't exceed the maximum size.
 * Removes oldest entries (first inserted) when limit is exceeded.
 */
function trimToolParametersCache(state: PluginState): void {
    if (state.toolParameters.size > MAX_TOOL_PARAMETERS_CACHE_SIZE) {
        const excess = state.toolParameters.size - MAX_TOOL_PARAMETERS_CACHE_SIZE
        const keys = Array.from(state.toolParameters.keys())
        for (let i = 0; i < excess; i++) {
            state.toolParameters.delete(keys[i])
        }
    }
}

/**
 * Cache tool parameters from OpenAI Chat Completions style messages.
 * Extracts tool call IDs and their parameters from assistant messages with tool_calls.
 * Returns the list of tool call IDs that were cached from this request.
 */
export function cacheToolParametersFromMessages(
    messages: any[],
    state: PluginState
): string[] {
    const cachedIds: string[] = []
    for (const message of messages) {
        if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
            continue
        }

        for (const toolCall of message.tool_calls) {
            if (!toolCall.id || !toolCall.function) {
                continue
            }

            try {
                const params = typeof toolCall.function.arguments === 'string'
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function.arguments
                state.toolParameters.set(toolCall.id, {
                    tool: toolCall.function.name,
                    parameters: params
                })
                cachedIds.push(toolCall.id)
            } catch (error) {
                // Silently ignore parse errors
            }
        }
    }
    trimToolParametersCache(state)
    return cachedIds
}

/**
 * Cache tool parameters from OpenAI Responses API format.
 * Extracts from input array items with type='function_call'.
 * Returns the list of tool call IDs that were cached from this request.
 */
export function cacheToolParametersFromInput(
    input: any[],
    state: PluginState
): string[] {
    const cachedIds: string[] = []
    for (const item of input) {
        if (item.type !== 'function_call' || !item.call_id || !item.name) {
            continue
        }

        try {
            const params = typeof item.arguments === 'string'
                ? JSON.parse(item.arguments)
                : item.arguments
            state.toolParameters.set(item.call_id, {
                tool: item.name,
                parameters: params
            })
            cachedIds.push(item.call_id)
        } catch (error) {
            // Silently ignore parse errors
        }
    }
    trimToolParametersCache(state)
    return cachedIds
}
