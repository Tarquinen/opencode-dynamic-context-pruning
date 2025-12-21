import type { Logger } from "../logger"
import type { SessionState } from "../state"
import { formatPrunedItemsList, formatTokenCount } from "./utils"
import { ToolParameterEntry } from "../state"
import { PluginConfig } from "../config"

export type PruneReason = "completion" | "noise" | "consolidation"
export const PRUNE_REASON_LABELS: Record<PruneReason, string> = {
    completion: "Task Complete",
    noise: "Noise Removal",
    consolidation: "Consolidation"
}

function formatStatsHeader(
    totalTokensSaved: number,
    pruneTokenCounter: number
): string {
    const totalTokensSavedStr = `~${formatTokenCount(totalTokensSaved + pruneTokenCounter)}`
    return [
        `▣ DCP | ${totalTokensSavedStr} saved total`,
    ].join('\n')
}

function buildMinimalMessage(
    state: SessionState,
    reason: PruneReason | undefined
): string {
    const reasonSuffix = reason ? ` [${PRUNE_REASON_LABELS[reason]}]` : ''
    return formatStatsHeader(
        state.stats.totalPruneTokens,
        state.stats.pruneTokenCounter
    ) + reasonSuffix
}

function buildDetailedMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    if (pruneToolIds.length > 0) {
        const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
        const reasonLabel = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ''
        message += `\n\n▣ Pruning (${pruneTokenCounterStr})${reasonLabel}`

        const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
        message += '\n' + itemLines.join('\n')
    }

    return message.trim()
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
    workingDirectory: string
): Promise<boolean> {
    const hasPruned = pruneToolIds.length > 0
    if (!hasPruned) {
        return false
    }

    if (config.pruningSummary === 'off') {
        return false
    }

    const message = config.pruningSummary === 'minimal'
        ? buildMinimalMessage(state, reason)
        : buildDetailedMessage(state, reason, pruneToolIds, toolMetadata, workingDirectory)

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

function formatDistillationMessage(distillation: Record<string, any>): string {
    const lines: string[] = ['▣ DCP | Extracted Distillation']

    for (const [id, findings] of Object.entries(distillation)) {
        lines.push(`\n─── ID ${id} ───`)
        if (typeof findings === 'object' && findings !== null) {
            lines.push(JSON.stringify(findings, null, 2))
        } else {
            lines.push(String(findings))
        }
    }

    return lines.join('\n')
}

export async function sendDistillationNotification(
    client: any,
    logger: Logger,
    sessionId: string,
    distillation: Record<string, any>,
    params: any
): Promise<boolean> {
    if (!distillation || Object.keys(distillation).length === 0) {
        return false
    }

    const message = formatDistillationMessage(distillation)
    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger
): Promise<void> {
    const agent = params.agent || undefined
    const model = params.providerId && params.modelId ? {
        providerID: params.providerId,
        modelID: params.modelId
    } : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                parts: [{
                    type: 'text',
                    text: text,
                    ignored: true
                }]
            }
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}

