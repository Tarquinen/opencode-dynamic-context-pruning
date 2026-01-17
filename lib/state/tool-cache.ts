import type { SessionState, ToolStatus, WithParts } from "./index"
import type { Logger } from "../logger"
import { PluginConfig } from "../config"
import { isMessageCompacted } from "../shared-utils"

const MAX_TOOL_CACHE_SIZE = 1000

/**
 * Sync tool parameters from OpenCode's session.messages() API.
 */
export async function syncToolCache(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    try {
        logger.info("Syncing tool parameters from OpenCode messages")

        state.nudgeCounter = 0
        let turnCounter = 0

        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue
            }

            for (const part of msg.parts) {
                if (part.type === "step-start") {
                    turnCounter++
                    continue
                }

                if (part.type !== "tool" || !part.callID) {
                    continue
                }

                const turnProtectionEnabled = config.turnProtection.enabled
                const turnProtectionTurns = config.turnProtection.turns
                const isProtectedByTurn =
                    turnProtectionEnabled &&
                    turnProtectionTurns > 0 &&
                    state.currentTurn - turnCounter < turnProtectionTurns

                state.lastToolPrune =
                    (part.tool === "discard" || part.tool === "extract") &&
                    part.state.status === "completed"

                const allProtectedTools = config.tools.settings.protectedTools

                if (part.tool === "discard" || part.tool === "extract") {
                    state.nudgeCounter = 0
                } else if (!allProtectedTools.includes(part.tool) && !isProtectedByTurn) {
                    state.nudgeCounter++
                }

                if (state.toolParameters.has(part.callID)) {
                    continue
                }

                if (isProtectedByTurn) {
                    continue
                }

                state.toolParameters.set(part.callID, {
                    tool: part.tool,
                    parameters: part.state?.input ?? {},
                    status: part.state.status as ToolStatus | undefined,
                    error: part.state.status === "error" ? part.state.error : undefined,
                    turn: turnCounter,
                })
                logger.info(`Cached tool id: ${part.callID} (created on turn ${turnCounter})`)
            }
        }

        logger.info(
            `Synced cache - size: ${state.toolParameters.size}, currentTurn: ${state.currentTurn}, nudgeCounter: ${state.nudgeCounter}`,
        )
        trimToolParametersCache(state)
    } catch (error) {
        logger.warn("Failed to sync tool parameters from OpenCode", {
            error: error instanceof Error ? error.message : String(error),
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

    const keysToRemove = Array.from(state.toolParameters.keys()).slice(
        0,
        state.toolParameters.size - MAX_TOOL_CACHE_SIZE,
    )

    for (const key of keysToRemove) {
        state.toolParameters.delete(key)
    }
}
