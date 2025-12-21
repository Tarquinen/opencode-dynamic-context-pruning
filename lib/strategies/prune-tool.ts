import { tool } from "@opencode-ai/plugin"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { buildToolIdList } from "../messages/utils"
import { PruneReason, sendUnifiedNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import type { Logger } from "../logger"
import { loadPrompt } from "../prompt"
import { calculateTokensSaved, getCurrentParams } from "./utils"

/** Tool description loaded from prompts/prune-tool-spec.txt */
const TOOL_DESCRIPTION = loadPrompt("prune-tool-spec")

export interface PruneToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
}

/**
 * Creates the prune tool definition.
 * Accepts numeric IDs from the <prunable-tools> list and prunes those tool outputs.
 */
export function createPruneTool(
    ctx: PruneToolContext,
): ReturnType<typeof tool> {
    return tool({
        description: TOOL_DESCRIPTION,
        args: {
            ids: tool.schema.array(
                tool.schema.string()
            ).describe(
                "Numeric IDs as strings to prune from the <prunable-tools> list"
            ),
            metadata: tool.schema.object({
                reason: tool.schema.enum(["completion", "noise", "consolidation"]).describe("The reason for pruning"),
                distillation: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe(
                    "An object containing detailed summaries or extractions of the key findings from the tools being pruned. This is REQUIRED for 'consolidation'."
                ),
            }).describe("Metadata about the pruning operation."),
        },
        async execute(args, toolCtx) {
            const { client, state, logger, config, workingDirectory } = ctx
            const sessionId = toolCtx.sessionID

            logger.info("Prune tool invoked")
            logger.info(JSON.stringify(args))

            // Check if prune tool is disabled for current provider
            const effectiveConfig = state.provider.effectiveConfig
            if (effectiveConfig && !effectiveConfig.enabled) {
                logger.info("Prune tool disabled for provider", { provider: state.provider.providerID })
                return `DCP is disabled for ${state.provider.providerID}. Pruning is not available.`
            }
            if (effectiveConfig && !effectiveConfig.strategies.pruneTool) {
                logger.info("Prune tool strategy disabled for provider", { provider: state.provider.providerID })
                return `Prune tool is disabled for ${state.provider.providerID}. Pruning is not available.`
            }

            if (!args.ids || args.ids.length === 0) {
                logger.debug("Prune tool called but args.ids is empty or undefined: " + JSON.stringify(args))
                return "No IDs provided. Check the <prunable-tools> list for available IDs to prune."
            }

            if (!args.metadata || !args.metadata.reason) {
                logger.debug("Prune tool called without metadata.reason: " + JSON.stringify(args))
                return "Missing metadata.reason. Provide metadata: { reason: 'completion' | 'noise' | 'consolidation' }"
            }

            const { reason, distillation } = args.metadata;

            const numericToolIds: number[] = args.ids
                .map(id => parseInt(id, 10))
                .filter((n): n is number => !isNaN(n))

            if (numericToolIds.length === 0) {
                logger.debug("No numeric tool IDs provided for pruning, yet prune tool was called: " + JSON.stringify(args))
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
                if (config.strategies.pruneTool.protectedTools.includes(metadata.tool)) {
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
                reason as PruneReason,
                currentParams,
                workingDirectory
            )

            state.stats.totalPruneTokens += state.stats.pruneTokenCounter
            state.stats.pruneTokenCounter = 0
            state.nudgeCounter = 0

            saveSessionState(state, logger)
                .catch(err => logger.error("Failed to persist state", { error: err.message }))

            const result = formatPruningResultForTool(
                pruneToolIds,
                toolMetadata,
                workingDirectory
            )
            //
            // if (distillation) {
            //     logger.info("Distillation data received:", distillation)
            // }

            return result
        },
    })
}

