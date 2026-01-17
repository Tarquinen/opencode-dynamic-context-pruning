import { tool } from "@opencode-ai/plugin"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { buildToolIdList } from "../messages/utils"
import { PruneReason, sendUnifiedNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import type { Logger } from "../logger"
import { loadPrompt } from "../prompts"
import { calculateTokensSaved, getCurrentParams } from "./utils"
import { getFilePathFromParameters, isProtectedFilePath } from "../protected-file-patterns"

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
    distillation?: string[],
): Promise<string> {
    const { client, state, logger, config, workingDirectory } = ctx
    const sessionId = toolCtx.sessionID

    logger.info(`${toolName} tool invoked`)
    logger.info(JSON.stringify(reason ? { ids, reason } : { ids }))

    if (!ids || ids.length === 0) {
        logger.debug(`${toolName} tool called but ids is empty or undefined`)
        throw new Error(
            `No IDs provided. Check the <prunable-tools> list for available IDs to ${toolName.toLowerCase()}.`,
        )
    }

    const numericToolIds: number[] = ids
        .map((id) => parseInt(id, 10))
        .filter((n): n is number => !isNaN(n))

    if (numericToolIds.length === 0) {
        logger.debug(`No numeric tool IDs provided for ${toolName}: ` + JSON.stringify(ids))
        throw new Error("No numeric IDs provided. Format: ids: [id1, id2, ...]")
    }

    // Fetch messages to calculate tokens and find current agent
    const messagesResponse = await client.session.messages({
        path: { id: sessionId },
    })
    const messages: WithParts[] = messagesResponse.data || messagesResponse

    await ensureSessionInitialized(ctx.client, state, sessionId, logger, messages)

    const currentParams = getCurrentParams(state, messages, logger)
    const toolIdList: string[] = buildToolIdList(state, messages, logger)

    // Validate that all numeric IDs are within bounds
    if (numericToolIds.some((id) => id < 0 || id >= toolIdList.length)) {
        logger.debug("Invalid tool IDs provided: " + numericToolIds.join(", "))
        throw new Error(
            "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list.",
        )
    }

    // Validate that all IDs exist in cache and aren't protected
    // (rejects hallucinated IDs and turn-protected tools not shown in <prunable-tools>)
    for (const index of numericToolIds) {
        const id = toolIdList[index]
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            logger.debug(
                "Rejecting prune request - ID not in cache (turn-protected or hallucinated)",
                { index, id },
            )
            throw new Error(
                "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list.",
            )
        }
        const allProtectedTools = config.tools.settings.protectedTools
        if (allProtectedTools.includes(metadata.tool)) {
            logger.debug("Rejecting prune request - protected tool", {
                index,
                id,
                tool: metadata.tool,
            })
            throw new Error(
                "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list.",
            )
        }

        const filePath = getFilePathFromParameters(metadata.parameters)
        if (isProtectedFilePath(filePath, config.protectedFilePatterns)) {
            logger.debug("Rejecting prune request - protected file path", {
                index,
                id,
                tool: metadata.tool,
                filePath,
            })
            throw new Error(
                "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list.",
            )
        }
    }

    const pruneToolIds: string[] = numericToolIds.map((index) => toolIdList[index])
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
        workingDirectory,
        distillation,
    )

    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0
    state.nudgeCounter = 0

    saveSessionState(state, logger).catch((err) =>
        logger.error("Failed to persist state", { error: err.message }),
    )

    return formatPruningResultForTool(pruneToolIds, toolMetadata, workingDirectory)
}

export function createDiscardTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: DISCARD_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema
                .array(tool.schema.string())
                .describe(
                    "First element is the reason ('completion' or 'noise'), followed by numeric IDs as strings to discard",
                ),
        },
        async execute(args, toolCtx) {
            // Parse reason from first element, numeric IDs from the rest
            const reason = args.ids?.[0]
            const validReasons = ["completion", "noise"] as const
            if (typeof reason !== "string" || !validReasons.includes(reason as any)) {
                ctx.logger.debug("Invalid discard reason provided: " + reason)
                throw new Error(
                    "No valid reason found. Use 'completion' or 'noise' as the first element.",
                )
            }

            const numericIds = args.ids.slice(1)

            return executePruneOperation(ctx, toolCtx, numericIds, reason as PruneReason, "Discard")
        },
    })
}

export function createExtractTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: EXTRACT_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema
                .array(tool.schema.string())
                .describe("Numeric IDs as strings to extract from the <prunable-tools> list"),
            distillation: tool.schema
                .array(tool.schema.string())
                .describe(
                    "REQUIRED. Array of strings, one per ID (positional: distillation[0] is for ids[0], etc.)",
                ),
        },
        async execute(args, toolCtx) {
            if (!args.distillation || args.distillation.length === 0) {
                ctx.logger.debug(
                    "Extract tool called without distillation: " + JSON.stringify(args),
                )
                throw new Error(
                    "Missing distillation. You must provide a distillation string for each ID.",
                )
            }

            // Log the distillation for debugging/analysis
            ctx.logger.info("Distillation data received:")
            ctx.logger.info(JSON.stringify(args.distillation, null, 2))

            return executePruneOperation(
                ctx,
                toolCtx,
                args.ids,
                "extraction" as PruneReason,
                "Extract",
                args.distillation,
            )
        },
    })
}
