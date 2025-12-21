import { tool } from "@opencode-ai/plugin"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { buildToolIdList } from "../messages/utils"
import { PruneReason, sendUnifiedNotification, sendDistillationNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import type { Logger } from "../logger"
import { loadPrompt } from "../prompt"
import { calculateTokensSaved, getCurrentParams } from "./utils"

const DISCARD_TOOL_DESCRIPTION = loadPrompt("discard-tool-spec")
const EXTRACT_TOOL_DESCRIPTION = loadPrompt("extract-tool-spec")

export interface PruneToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
}

// Shared logic for executing prune operations.
async function executePruneOperation(
    ctx: PruneToolContext,
    toolCtx: { sessionID: string },
    ids: string[],
    reason: PruneReason,
    toolName: string,
    distillation?: Record<string, any>
): Promise<string> {
    const { client, state, logger, config, workingDirectory } = ctx
    const sessionId = toolCtx.sessionID

    logger.info(`${toolName} tool invoked`)
    logger.info(JSON.stringify({ ids, reason }))

    if (!ids || ids.length === 0) {
        logger.debug(`${toolName} tool called but ids is empty or undefined`)
        return `No IDs provided. Check the <prunable-tools> list for available IDs to ${toolName.toLowerCase()}.`
    }

    const numericToolIds: number[] = ids
        .map(id => parseInt(id, 10))
        .filter((n): n is number => !isNaN(n))

    if (numericToolIds.length === 0) {
        logger.debug(`No numeric tool IDs provided for ${toolName}: ` + JSON.stringify(ids))
        return "No numeric IDs provided. Format: ids: [id1, id2, ...]"
    }

    // Fetch messages to calculate tokens and find current agent
    const messagesResponse = await client.session.messages({
        path: { id: sessionId }
    })
    const messages: WithParts[] = messagesResponse.data || messagesResponse

    await ensureSessionInitialized(ctx.client, state, sessionId, logger, messages)

    const currentParams = getCurrentParams(messages, logger)
    const toolIdList: string[] = buildToolIdList(state, messages, logger)

    // Validate that all numeric IDs are within bounds
    if (numericToolIds.some(id => id < 0 || id >= toolIdList.length)) {
        logger.debug("Invalid tool IDs provided: " + numericToolIds.join(", "))
        return "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list."
    }

    // Validate that all IDs exist in cache and aren't protected
    // (rejects hallucinated IDs and turn-protected tools not shown in <prunable-tools>)
    for (const index of numericToolIds) {
        const id = toolIdList[index]
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            logger.debug("Rejecting prune request - ID not in cache (turn-protected or hallucinated)", { index, id })
            return "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list."
        }
        const allProtectedTools = [
            ...config.strategies.discardTool.protectedTools,
            ...config.strategies.extractTool.protectedTools
        ]
        if (allProtectedTools.includes(metadata.tool)) {
            logger.debug("Rejecting prune request - protected tool", { index, id, tool: metadata.tool })
            return "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list."
        }
    }

    const pruneToolIds: string[] = numericToolIds.map(index => toolIdList[index])
    state.prune.toolIds.push(...pruneToolIds)

    const toolMetadata = new Map<string, ToolParameterEntry>()
    for (const id of pruneToolIds) {
        const toolParameters = state.toolParameters.get(id)
        if (toolParameters) {
            toolMetadata.set(id, toolParameters)
        } else {
            logger.debug("No metadata found for ID", { id })
        }
    }

    state.stats.pruneTokenCounter += calculateTokensSaved(state, messages, pruneToolIds)

    await sendUnifiedNotification(
        client,
        logger,
        config,
        state,
        sessionId,
        pruneToolIds,
        toolMetadata,
        reason,
        currentParams,
        workingDirectory
    )

    if (distillation && config.strategies.extractTool.showDistillation) {
        await sendDistillationNotification(
            client,
            logger,
            sessionId,
            distillation,
            currentParams
        )
    }

    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0
    state.nudgeCounter = 0

    saveSessionState(state, logger)
        .catch(err => logger.error("Failed to persist state", { error: err.message }))

    return formatPruningResultForTool(
        pruneToolIds,
        toolMetadata,
        workingDirectory
    )
}

export function createDiscardTool(
    ctx: PruneToolContext,
): ReturnType<typeof tool> {
    return tool({
        description: DISCARD_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema.array(
                tool.schema.string()
            ).describe(
                "First element is the reason ('completion' or 'noise'), followed by numeric IDs as strings to discard"
            ),
        },
        async execute(args, toolCtx) {
            // Parse reason from first element, numeric IDs from the rest
            const reason = args.ids?.[0]
            const validReasons = ["completion", "noise"] as const
            if (typeof reason !== "string" || !validReasons.includes(reason as any)) {
                ctx.logger.debug("Invalid discard reason provided: " + reason)
                return "No valid reason found. Use 'completion' or 'noise' as the first element."
            }

            const numericIds = args.ids.slice(1)

            return executePruneOperation(
                ctx,
                toolCtx,
                numericIds,
                reason as PruneReason,
                "Discard"
            )
        },
    })
}

export function createExtractTool(
    ctx: PruneToolContext,
): ReturnType<typeof tool> {
    return tool({
        description: EXTRACT_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema.array(
                tool.schema.string()
            ).describe(
                "Numeric IDs as strings to extract from the <prunable-tools> list"
            ),
            distillation: tool.schema.record(tool.schema.string(), tool.schema.any()).describe(
                "REQUIRED. An object mapping each ID to its distilled findings. Must contain an entry for every ID being pruned."
            ),
        },
        async execute(args, toolCtx) {
            if (!args.distillation || Object.keys(args.distillation).length === 0) {
                ctx.logger.debug("Extract tool called without distillation: " + JSON.stringify(args))
                return "Missing distillation. You must provide distillation data when using extract. Format: distillation: { \"id\": { ...findings... } }"
            }

            // Log the distillation for debugging/analysis
            ctx.logger.info("Distillation data received:")
            ctx.logger.info(JSON.stringify(args.distillation, null, 2))

            return executePruneOperation(
                ctx,
                toolCtx,
                args.ids,
                "consolidation" as PruneReason,
                "Extract",
                args.distillation
            )
        },
    })
}
