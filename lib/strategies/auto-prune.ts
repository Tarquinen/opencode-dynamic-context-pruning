import type { SessionState, WithParts, ToolParameterEntry } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { buildToolIdList } from "../messages/utils"
import { sendAutoPruneNotification } from "../ui/notification"
import { calculateTokensSaved, getCurrentParams } from "./utils"
import { saveSessionState } from "../state/persistence"

/**
 * Expires pins that have exceeded their duration.
 */
function expirePins(state: SessionState, logger: Logger): string[] {
    const expired: string[] = []
    state.pins.forEach((pin, toolCallId) => {
        if (state.currentTurn >= pin.expiresAtTurn) {
            expired.push(toolCallId)
        }
    })

    for (const id of expired) {
        state.pins.delete(id)
        logger.debug(`Pin expired: ${id}`)
    }

    if (expired.length > 0) {
        logger.info(`Expired ${expired.length} pin(s)`)
    }

    return expired
}

/**
 * Checks if a tool is protected from pruning.
 */
function isProtectedTool(toolName: string, config: PluginConfig): boolean {
    return config.tools.settings.protectedTools.includes(toolName)
}

/**
 * Returns the number of turns until the next auto-prune.
 */
export function turnsUntilAutoPrune(state: SessionState, config: PluginConfig): number {
    if (!config.tools.pinningMode.enabled) return Infinity
    const { pruneFrequency } = config.tools.pinningMode
    const turnsSinceLastPrune = state.currentTurn - state.lastAutoPruneTurn
    return Math.max(0, pruneFrequency - turnsSinceLastPrune)
}

/**
 * Checks if an auto-prune warning should be shown.
 */
export function shouldShowAutoPruneWarning(state: SessionState, config: PluginConfig): boolean {
    if (!config.tools.pinningMode.enabled) return false
    const { warningTurns } = config.tools.pinningMode
    const turns = turnsUntilAutoPrune(state, config)
    return turns <= warningTurns && turns > 0
}

/**
 * Auto-prune strategy: prunes all unpinned tools when the prune frequency is reached.
 */
export async function autoPrune(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
    workingDirectory: string,
): Promise<void> {
    if (!config.tools.pinningMode.enabled) return

    const { pruneFrequency } = config.tools.pinningMode
    const turnsSinceLastPrune = state.currentTurn - state.lastAutoPruneTurn

    // Not time yet
    if (turnsSinceLastPrune < pruneFrequency) {
        logger.debug(`Auto-prune: ${pruneFrequency - turnsSinceLastPrune} turns until next prune`)
        return
    }

    logger.info(`Auto-prune triggered at turn ${state.currentTurn}`)

    // Expire old pins first
    expirePins(state, logger)

    // Build the tool ID list
    const toolIdList = buildToolIdList(state, messages, logger)

    // Collect unpinned tool IDs
    const unpinnedIds: string[] = []
    const toolMetadata = new Map<string, ToolParameterEntry>()

    state.toolParameters.forEach((entry, toolCallId) => {
        // Skip if pinned
        if (state.pins.has(toolCallId)) {
            logger.debug(`Skipping pinned tool: ${toolCallId}`)
            return
        }

        // Skip if already pruned
        if (state.prune.toolIds.includes(toolCallId)) {
            return
        }

        // Skip if protected
        if (isProtectedTool(entry.tool, config)) {
            logger.debug(`Skipping protected tool: ${entry.tool}`)
            return
        }

        // Skip if not in current message list (may have been compacted)
        if (!toolIdList.includes(toolCallId)) {
            return
        }

        unpinnedIds.push(toolCallId)
        toolMetadata.set(toolCallId, entry)
    })

    if (unpinnedIds.length === 0) {
        logger.info("Auto-prune: no unpinned tools to prune")
        state.lastAutoPruneTurn = state.currentTurn
        return
    }

    // Mark for pruning
    state.prune.toolIds.push(...unpinnedIds)

    // Calculate tokens saved
    const tokensSaved = calculateTokensSaved(state, messages, unpinnedIds)
    state.stats.pruneTokenCounter += tokensSaved

    logger.info(`Auto-prune: discarded ${unpinnedIds.length} unpinned tools`, {
        kept: state.pins.size,
        tokensSaved,
    })

    // Send notification
    const currentParams = getCurrentParams(state, messages, logger)
    await sendAutoPruneNotification(
        client,
        logger,
        config,
        state,
        state.sessionId!,
        unpinnedIds,
        toolMetadata,
        currentParams,
        workingDirectory,
    )

    // Update stats
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0
    state.lastAutoPruneTurn = state.currentTurn

    // Persist state
    saveSessionState(state, logger).catch((err) =>
        logger.error("Failed to persist state after auto-prune", { error: err.message }),
    )
}
