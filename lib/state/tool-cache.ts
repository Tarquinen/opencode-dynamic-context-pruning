import type { PluginState, ToolStatus } from "./index"
import type { Logger } from "../logger"
import type { ToolTracker } from "../fetch-wrapper/tool-tracker"

/** Maximum number of entries to keep in the tool parameters cache */
const MAX_TOOL_CACHE_SIZE = 500

/**
 * Sync tool parameters from OpenCode's session.messages() API.
 * This is the single source of truth for tool parameters, replacing
 * format-specific parsing from LLM API requests.
 */
export async function syncToolCache(
    client: any,
    sessionId: string,
    state: PluginState,
    tracker?: ToolTracker,
    protectedTools?: Set<string>,
    logger?: Logger
): Promise<void> {
    try {
        const messagesResponse = await client.session.messages({
            path: { id: sessionId },
            query: { limit: 100 }
        })
        const messages = messagesResponse.data || messagesResponse

        if (!Array.isArray(messages)) {
            return
        }

        let synced = 0

        for (const msg of messages) {
            if (!msg.parts) continue

            for (const part of msg.parts) {
                if (part.type !== "tool" || !part.callID) continue

                const id = part.callID.toLowerCase()

                // Track tool results for nudge injection
                if (tracker && !tracker.seenToolResultIds.has(id)) {
                    tracker.seenToolResultIds.add(id)
                    // Only count non-protected tools toward nudge threshold
                    if (!part.tool || !protectedTools?.has(part.tool)) {
                        tracker.toolResultCount++
                    }
                }

                if (state.toolParameters.has(id)) continue
                if (part.tool && protectedTools?.has(part.tool)) continue

                const status = part.state?.status as ToolStatus | undefined
                state.toolParameters.set(id, {
                    tool: part.tool,
                    parameters: part.state?.input ?? {},
                    status,
                    error: status === "error" ? part.state?.error : undefined,
                })
                synced++
            }
        }

        trimToolParametersCache(state)

        if (logger && synced > 0) {
            logger.debug("tool-cache", "Synced tool parameters from OpenCode", {
                sessionId: sessionId.slice(0, 8),
                synced
            })
        }
    } catch (error) {
        logger?.warn("tool-cache", "Failed to sync tool parameters from OpenCode", {
            sessionId: sessionId.slice(0, 8),
            error: error instanceof Error ? error.message : String(error)
        })
    }
}

/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses FIFO eviction - removes oldest entries first.
 */
export function trimToolParametersCache(state: PluginState): void {
    if (state.toolParameters.size <= MAX_TOOL_CACHE_SIZE) {
        return
    }

    const keysToRemove = Array.from(state.toolParameters.keys())
        .slice(0, state.toolParameters.size - MAX_TOOL_CACHE_SIZE)

    for (const key of keysToRemove) {
        state.toolParameters.delete(key)
    }
}
