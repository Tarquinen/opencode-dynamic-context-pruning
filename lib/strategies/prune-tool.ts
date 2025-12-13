import { tool } from "@opencode-ai/plugin"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { findCurrentAgent, buildToolIdList, getPruneToolIds, calculateTokensSaved } from "../utils"
import { PruneReason, sendUnifiedNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/display-utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import type { Logger } from "../logger"
import { loadPrompt } from "../prompt"

/** Tool description loaded from prompts/tool.txt */
const TOOL_DESCRIPTION = loadPrompt("tool")

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
                tool.schema.union([
                    tool.schema.enum(["completion", "noise", "consolidation"]),
                    tool.schema.number()
                ])
            ).describe(
                "First element is the reason ('completion', 'noise', 'consolidation'), followed by numeric IDs to prune"
            ),
        },
        async execute(args, toolCtx) {
            const { client, state, logger, config, workingDirectory } = ctx
            const sessionId = toolCtx.sessionID

            if (!args.ids || args.ids.length === 0) {
                return "No IDs provided. Check the <prunable-tools> list for available IDs to prune."
            }

            // Parse reason from first element, numeric IDs from the rest

            const reason = args.ids[0];
            const validReasons = ["completion", "noise", "consolidation"] as const
            if (typeof reason !== "string" || !validReasons.includes(reason as any)) {
                return "No valid pruning reason found. Use 'completion', 'noise', or 'consolidation' as the first element."
            }

            const numericToolIds: number[] = args.ids.slice(1).filter((id): id is number => typeof id === "number")
            if (numericToolIds.length === 0) {
                return "No numeric IDs provided. Format: [reason, id1, id2, ...] where reason is 'completion', 'noise', or 'consolidation'."
            }

            await ensureSessionInitialized(ctx.client, state, sessionId, logger)

            // Fetch messages to calculate tokens and find current agent
            const messagesResponse = await client.session.messages({
                path: { id: sessionId }
            })
            const messages: WithParts[] = messagesResponse.data || messagesResponse

            const currentAgent: string | undefined = findCurrentAgent(messages)
            const toolIdList: string[] = buildToolIdList(messages)
            const pruneToolIds: string[] = getPruneToolIds(numericToolIds, toolIdList)
            state.prune.toolIds.push(...pruneToolIds)

            saveSessionState(state, logger)
                .catch(err => logger.error("Failed to persist state", { error: err.message }))

            const toolMetadata = new Map<string, ToolParameterEntry>()
            for (const id of pruneToolIds) {
                const toolParameters = state.toolParameters.get(id)
                if (toolParameters) {
                    toolMetadata.set(id, toolParameters)
                } else {
                    logger.debug("No metadata found for ID", { id })
                }
            }

            state.stats.pruneTokenCounter += calculateTokensSaved(messages, pruneToolIds)

            await sendUnifiedNotification(
                client,
                logger,
                config,
                state,
                sessionId,
                pruneToolIds,
                toolMetadata,
                reason as PruneReason,
                currentAgent,
                workingDirectory
            )
            state.stats.totalPruneTokens += state.stats.pruneTokenCounter
            state.stats.pruneTokenCounter = 0
            state.nudgeCounter = 0

            return formatPruningResultForTool(
                pruneToolIds,
                toolMetadata,
                workingDirectory
            )
        },
    })
}

