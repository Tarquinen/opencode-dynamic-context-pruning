import type { SessionState, ToolStatus, WithParts } from "./index"
import type { Logger } from "../logger"
import { PluginConfig } from "../config"

const MAX_TOOL_CACHE_SIZE = 500

/**
 * Sync tool parameters from OpenCode's session.messages() API.
 * This is the single source of truth for tool parameters, replacing
 * format-specific parsing from LLM API requests.
 */
export async function syncToolCache(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    try {
        logger.info("Syncing tool parameters from OpenCode messages")

        for (const msg of messages) {
            for (const part of msg.parts) {
                if (part.type !== "tool" || !part.callID || state.toolParameters.has(part.callID)) {
                    continue
                }

                state.toolParameters.set(
                    part.callID,
                    {
                        tool: part.tool,
                        parameters: part.state?.input ?? {},
                        status: part.state.status as ToolStatus | undefined,
                        error: part.state.status === "error" ? part.state.error : undefined,
                        compacted: part.state.status === "completed" && !!part.state.time.compacted,
                    }
                )

                if (!config.strategies.pruneTool.protectedTools.includes(part.tool)) {
                    state.nudgeCounter++
                }

                state.lastToolPrune = part.tool === "prune"
                logger.info("lastToolPrune=" + String(state.lastToolPrune))
            }
        }

        trimToolParametersCache(state)
    } catch (error) {
        logger.warn("Failed to sync tool parameters from OpenCode", {
            error: error instanceof Error ? error.message : String(error)
        })
    }
}

/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses FIFO eviction - removes oldest entries first.
 */
export function trimToolParametersCache(state: SessionState): void {
    if (state.toolParameters.size <= MAX_TOOL_CACHE_SIZE) {
        return
    }

    const keysToRemove = Array.from(state.toolParameters.keys())
        .slice(0, state.toolParameters.size - MAX_TOOL_CACHE_SIZE)

    for (const key of keysToRemove) {
        state.toolParameters.delete(key)
    }
}
