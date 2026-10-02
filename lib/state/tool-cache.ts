import type { SessionState, ToolStatus, WithParts } from "./index"
import type { Logger } from "../logger"
import { PluginConfig } from "../config"
import { isMessageCompacted } from "./utils"
import { countToolTokens } from "../token-utils"
import { getAmbiguousToolIds } from "../tool-ids"

const MAX_TOOL_CACHE_SIZE = 1000

/**
 * Sync tool parameters from session messages.
 */
export function syncToolCache(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void {
    try {
        logger.info("Syncing tool parameters from OpenCode messages")

        const ambiguousIds = getAmbiguousToolIds(messages)
        for (const id of ambiguousIds) {
            state.toolParameters.delete(id)
            state.prune.tools.delete(id)
        }

        let turnCounter = 0

        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue
            }

            const parts = Array.isArray(msg.parts) ? msg.parts : []
            for (const part of parts) {
                if (part.type === "step-start") {
                    turnCounter++
                    continue
                }

                if (part.type !== "tool" || !part.callID || ambiguousIds.has(part.callID)) {
                    continue
                }

                const turnProtectionEnabled = config.turnProtection.enabled
                const turnProtectionTurns = config.turnProtection.turns
                const isProtectedByTurn =
                    turnProtectionEnabled &&
                    turnProtectionTurns > 0 &&
                    state.currentTurn - turnCounter < turnProtectionTurns

                if (state.toolParameters.has(part.callID)) {
                    continue
                }

                if (isProtectedByTurn) {
                    continue
                }

                const tokenCount = countToolTokens(part)

                state.toolParameters.set(part.callID, {
                    tool: part.tool,
                    parameters: part.state?.input ?? {},
                    metadata: "metadata" in part.state ? part.state.metadata : undefined,
                    status: part.state.status as ToolStatus | undefined,
                    error: part.state.status === "error" ? part.state.error : undefined,
                    turn: turnCounter,
                    tokenCount,
                })
                logger.info(
                    `Cached tool id: ${part.callID} (turn ${turnCounter}${tokenCount !== undefined ? `, ${tokenCount} tokens` : ""})`,
                )
            }
        }

        logger.info(
            `Synced cache - size: ${state.toolParameters.size}, currentTurn: ${state.currentTurn}`,
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
