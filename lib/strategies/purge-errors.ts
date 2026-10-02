import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { isToolProtected } from "../protected-patterns"
import { getTotalToolTokens } from "../token-utils"
import { getAmbiguousToolIds } from "../tool-ids"

/**
 * Purge Errors strategy - prunes tool inputs for tools that errored
 * after they are older than a configurable number of turns.
 * The error message is preserved, but the (potentially large) inputs
 * are removed to save context.
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const purgeErrors = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (state.manualMode && !config.manualMode.automaticStrategies) {
        return
    }

    if (!config.strategies.purgeErrors.enabled) {
        return
    }

    const allToolIds = state.toolIdList
    if (allToolIds.length === 0) {
        return
    }

    // Filter out IDs already pruned
    const ambiguousIds = getAmbiguousToolIds(messages)
    const unprunedIds = allToolIds.filter(
        (id) => !state.prune.tools.has(id) && !ambiguousIds.has(id),
    )

    if (unprunedIds.length === 0) {
        return
    }

    const protectedTools = config.strategies.purgeErrors.protectedTools
    const turnThreshold = Math.max(1, config.strategies.purgeErrors.turns)

    const newPruneIds: string[] = []

    for (const id of unprunedIds) {
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            continue
        }

        if (
            isToolProtected(
                metadata.tool,
                metadata.parameters,
                protectedTools,
                config.protectedFilePatterns,
                metadata.metadata,
            )
        ) {
            continue
        }

        // Only process error tools
        if (metadata.status !== "error") {
            continue
        }

        // Check if the tool is old enough to prune
        const turnAge = state.currentTurn - metadata.turn
        if (turnAge >= turnThreshold) {
            newPruneIds.push(id)
        }
    }

    if (newPruneIds.length > 0) {
        state.stats.totalPruneTokens += getTotalToolTokens(state, newPruneIds)
        for (const id of newPruneIds) {
            const entry = state.toolParameters.get(id)
            state.prune.tools.set(id, entry?.tokenCount ?? 0)
        }
        logger.debug(
            `Marked ${newPruneIds.length} error tool calls for pruning (older than ${turnThreshold} turns)`,
        )
    }
}
