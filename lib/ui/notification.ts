import type { Logger } from "../logger"
import type { SessionState } from "../state"
import {
    formatExtracted,
    formatPrunedItemsList,
    formatStatsHeader,
    formatTokenCount,
} from "./utils"
import { ToolParameterEntry } from "../state"
import { PluginConfig } from "../config"

export type PruneReason = "completion" | "noise" | "extraction" | "auto-prune"
export const PRUNE_REASON_LABELS: Record<PruneReason, string> = {
    completion: "Task Complete",
    noise: "Noise Removal",
    extraction: "Extraction",
    "auto-prune": "Auto-Prune",
}

function buildMinimalMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    distillation?: string[],
): string {
    const reasonSuffix = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
    let message =
        formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter) +
        reasonSuffix

    return message + formatExtracted(distillation)
}

function buildDetailedMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
    distillation?: string[],
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    if (pruneToolIds.length > 0) {
        const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
        const reasonLabel = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
        message += `\n\n▣ Pruning (${pruneTokenCounterStr})${reasonLabel}`

        const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
        message += "\n" + itemLines.join("\n")
    }

    return (message + formatExtracted(distillation)).trim()
}

export async function sendUnifiedNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    reason: PruneReason | undefined,
    params: any,
    workingDirectory: string,
    distillation?: string[],
): Promise<boolean> {
    const hasPruned = pruneToolIds.length > 0
    if (!hasPruned) {
        return false
    }

    if (config.pruneNotification === "off") {
        return false
    }

    const showExtraction = config.tools.extract.showDistillation ? distillation : undefined

    const message =
        config.pruneNotification === "minimal"
            ? buildMinimalMessage(state, reason, showExtraction)
            : buildDetailedMessage(
                  state,
                  reason,
                  pruneToolIds,
                  toolMetadata,
                  workingDirectory,
                  showExtraction,
              )

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendAutoPruneNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    params: any,
    workingDirectory: string,
): Promise<boolean> {
    if (pruneToolIds.length === 0) {
        return false
    }

    if (config.pruneNotification === "off") {
        return false
    }

    const pinnedCount = state.pins.size
    const prunedCount = pruneToolIds.length

    const message =
        config.pruneNotification === "minimal"
            ? buildMinimalAutoPruneMessage(state, prunedCount, pinnedCount)
            : buildDetailedAutoPruneMessage(
                  state,
                  prunedCount,
                  pinnedCount,
                  pruneToolIds,
                  toolMetadata,
                  workingDirectory,
              )

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

function buildMinimalAutoPruneMessage(
    state: SessionState,
    prunedCount: number,
    pinnedCount: number,
): string {
    return (
        formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter) +
        ` — Auto-Prune: ${prunedCount} discarded, ${pinnedCount} pinned`
    )
}

function buildDetailedAutoPruneMessage(
    state: SessionState,
    prunedCount: number,
    pinnedCount: number,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
    message += `\n\n▣ Auto-Prune (${pruneTokenCounterStr}) — ${prunedCount} discarded, ${pinnedCount} pinned`

    const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
    message += "\n" + itemLines.join("\n")

    return message.trim()
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    const agent = params.agent || undefined
    const variant = params.variant || undefined
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID,
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                variant: variant,
                parts: [
                    {
                        type: "text",
                        text: text,
                        ignored: true,
                    },
                ],
            },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
