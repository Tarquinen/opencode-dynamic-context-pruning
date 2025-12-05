import { tool } from "@opencode-ai/plugin"
import type { PluginState } from "./state"
import type { PluginConfig } from "./config"
import type { ToolTracker } from "./fetch-wrapper/tool-tracker"
import { resetToolTrackerCount } from "./fetch-wrapper/tool-tracker"
import { isSubagentSession } from "./hooks"
import { getActualId } from "./state/id-mapping"
import { formatPruningResultForTool, sendUnifiedNotification, type NotificationContext } from "./ui/notification"
import { ensureSessionRestored } from "./state"
import { saveSessionState } from "./state/persistence"
import type { Logger } from "./logger"
import { estimateTokensBatch } from "./tokenizer"
import type { SessionStats } from "./core/janitor"
import { loadPrompt } from "./core/prompt"

/** Tool description loaded from prompts/tool.txt */
const TOOL_DESCRIPTION = loadPrompt("tool")

export interface PruneToolContext {
    client: any
    state: PluginState
    logger: Logger
    config: PluginConfig
    notificationCtx: NotificationContext
    workingDirectory?: string
}

/**
 * Creates the prune tool definition.
 * Accepts numeric IDs from the <prunable-tools> list and prunes those tool outputs.
 */
export function createPruningTool(
    ctx: PruneToolContext,
    toolTracker: ToolTracker
): ReturnType<typeof tool> {
    return tool({
        description: TOOL_DESCRIPTION,
        args: {
            ids: tool.schema.array(tool.schema.number()).describe(
                "Array of numeric IDs to prune from the <prunable-tools> list"
            ),
        },
        async execute(args, toolCtx) {
            const { client, state, logger, config, notificationCtx, workingDirectory } = ctx
            const sessionId = toolCtx.sessionID

            if (await isSubagentSession(client, sessionId)) {
                return "Pruning is unavailable in subagent sessions. Do not call this tool again. Continue with your current task - if you were in the middle of work, proceed with your next step. If you had just finished, provide your final summary/findings to return to the main agent."
            }

            if (!args.ids || args.ids.length === 0) {
                return "No IDs provided. Check the <prunable-tools> list for available IDs to prune."
            }

            await ensureSessionRestored(state, sessionId, logger)

            const prunedIds = args.ids
                .map(numId => getActualId(sessionId, numId))
                .filter((id): id is string => id !== undefined)

            if (prunedIds.length === 0) {
                return "None of the provided IDs were valid. Check the <prunable-tools> list for available IDs."
            }

            // Fetch messages to calculate tokens and find current agent
            const messagesResponse = await client.session.messages({
                path: { id: sessionId },
                query: { limit: 200 }
            })
            const messages = messagesResponse.data || messagesResponse

            const currentAgent = findCurrentAgent(messages)
            const tokensSaved = await calculateTokensSavedFromMessages(messages, prunedIds)

            const currentStats = state.stats.get(sessionId) ?? {
                totalToolsPruned: 0,
                totalTokensSaved: 0,
                totalGCTokens: 0,
                totalGCTools: 0
            }
            const sessionStats: SessionStats = {
                ...currentStats,
                totalToolsPruned: currentStats.totalToolsPruned + prunedIds.length,
                totalTokensSaved: currentStats.totalTokensSaved + tokensSaved
            }
            state.stats.set(sessionId, sessionStats)

            const alreadyPrunedIds = state.prunedIds.get(sessionId) ?? []
            const allPrunedIds = [...alreadyPrunedIds, ...prunedIds]
            state.prunedIds.set(sessionId, allPrunedIds)

            saveSessionState(sessionId, new Set(allPrunedIds), sessionStats, logger)
                .catch(err => logger.error("prune-tool", "Failed to persist state", { error: err.message }))

            const toolMetadata = new Map<string, { tool: string, parameters?: any }>()
            for (const id of prunedIds) {
                const meta = state.toolParameters.get(id.toLowerCase())
                if (meta) {
                    toolMetadata.set(id.toLowerCase(), meta)
                } else {
                    logger.debug("prune-tool", "No metadata found for ID", {
                        id,
                        idLower: id.toLowerCase(),
                        hasLower: state.toolParameters.has(id.toLowerCase())
                    })
                }
            }

            await sendUnifiedNotification(notificationCtx, sessionId, {
                aiPrunedCount: prunedIds.length,
                aiTokensSaved: tokensSaved,
                aiPrunedIds: prunedIds,
                toolMetadata,
                gcPending: null,
                sessionStats
            }, currentAgent)

            toolTracker.skipNextIdle = true

            if (config.nudge_freq > 0) {
                resetToolTrackerCount(toolTracker)
            }

            const result = {
                prunedCount: prunedIds.length,
                tokensSaved,
                llmPrunedIds: prunedIds,
                toolMetadata,
                sessionStats
            }

            const postPruneGuidance = "\n\nYou have already distilled relevant understanding in writing before calling this tool. Do not re-narrate; continue with your next task."

            return formatPruningResultForTool(result, workingDirectory) + postPruneGuidance
        },
    })
}

/**
 * Finds the current agent from messages (same logic as janitor.ts).
 */
function findCurrentAgent(messages: any[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const info = msg.info
        if (info?.role === 'user') {
            return info.agent || 'build'
        }
    }
    return undefined
}

/**
 * Calculates approximate tokens saved by pruning the given tool call IDs.
 * Uses pre-fetched messages to avoid duplicate API calls.
 */
async function calculateTokensSavedFromMessages(
    messages: any[],
    prunedIds: string[]
): Promise<number> {
    try {
        const toolOutputs = new Map<string, string>()
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.tool_call_id) {
                const content = typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content)
                toolOutputs.set(msg.tool_call_id.toLowerCase(), content)
            }
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'tool_result' && part.tool_use_id) {
                        const content = typeof part.content === 'string'
                            ? part.content
                            : JSON.stringify(part.content)
                        toolOutputs.set(part.tool_use_id.toLowerCase(), content)
                    }
                }
            }
        }

        const contents: string[] = []
        for (const id of prunedIds) {
            const content = toolOutputs.get(id.toLowerCase())
            if (content) {
                contents.push(content)
            }
        }

        if (contents.length === 0) {
            return prunedIds.length * 500
        }

        const tokenCounts = await estimateTokensBatch(contents)
        return tokenCounts.reduce((sum, count) => sum + count, 0)
    } catch (error: any) {
        return prunedIds.length * 500
    }
}
