import { z } from "zod"
import type { SessionState, WithParts, ToolParameterEntry } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { buildAnalysisPrompt } from "../prompt"
import { selectModel, extractModelFromSession, ModelInfo } from "../model-selector"
import { calculateTokensSaved, findCurrentAgent } from "../utils"
import { saveSessionState } from "../state/persistence"
import { sendUnifiedNotification } from "../ui/notification"

export interface OnIdleResult {
    prunedCount: number
    tokensSaved: number
    prunedIds: string[]
}

/**
 * Parse messages to extract tool information.
 */
function parseMessages(
    messages: WithParts[],
    toolParametersCache: Map<string, ToolParameterEntry>
): {
    toolCallIds: string[]
    toolMetadata: Map<string, ToolParameterEntry>
} {
    const toolCallIds: string[] = []
    const toolMetadata = new Map<string, ToolParameterEntry>()

    for (const msg of messages) {
        if (msg.parts) {
            for (const part of msg.parts) {
                if (part.type === "tool" && part.callID) {
                    toolCallIds.push(part.callID)

                    const cachedData = toolParametersCache.get(part.callID)
                    const parameters = cachedData?.parameters ?? part.state?.input ?? {}

                    toolMetadata.set(part.callID, {
                        tool: part.tool,
                        parameters: parameters,
                        status: part.state?.status,
                        error: part.state?.status === "error" ? part.state.error : undefined
                    })
                }
            }
        }
    }

    return { toolCallIds, toolMetadata }
}

/**
 * Replace pruned tool outputs in messages for LLM analysis.
 */
function replacePrunedToolOutputs(messages: WithParts[], prunedIds: string[]): WithParts[] {
    if (prunedIds.length === 0) return messages

    const prunedIdsSet = new Set(prunedIds)

    return messages.map(msg => {
        if (!msg.parts) return msg

        return {
            ...msg,
            parts: msg.parts.map((part: any) => {
                if (part.type === 'tool' &&
                    part.callID &&
                    prunedIdsSet.has(part.callID) &&
                    part.state?.output) {
                    return {
                        ...part,
                        state: {
                            ...part.state,
                            output: '[Output removed to save context - information superseded or no longer needed]'
                        }
                    }
                }
                return part
            })
        }
    }) as WithParts[]
}

/**
 * Run LLM analysis to determine which tool calls can be pruned.
 */
async function runLlmAnalysis(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
    unprunedToolCallIds: string[],
    alreadyPrunedIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string
): Promise<string[]> {
    const protectedToolCallIds: string[] = []
    const prunableToolCallIds = unprunedToolCallIds.filter(id => {
        const metadata = toolMetadata.get(id)
        if (metadata && config.strategies.onIdle.protectedTools.includes(metadata.tool)) {
            protectedToolCallIds.push(id)
            return false
        }
        return true
    })

    if (prunableToolCallIds.length === 0) {
        return []
    }

    // Get model info from messages
    let validModelInfo: ModelInfo | undefined = undefined
    if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1]
        const model = (lastMessage.info as any)?.model
        if (model?.providerID && model?.modelID) {
            validModelInfo = {
                providerID: model.providerID,
                modelID: model.modelID
            }
        }
    }

    const modelSelection = await selectModel(
        validModelInfo,
        logger,
        config.strategies.onIdle.model,
        workingDirectory
    )

    logger.info(`OnIdle Model: ${modelSelection.modelInfo.providerID}/${modelSelection.modelInfo.modelID}`, {
        source: modelSelection.source
    })

    if (modelSelection.failedModel && config.strategies.onIdle.showModelErrorToasts) {
        const skipAi = modelSelection.source === 'fallback' && config.strategies.onIdle.strictModelSelection
        try {
            await client.tui.showToast({
                body: {
                    title: skipAi ? "DCP: AI analysis skipped" : "DCP: Model fallback",
                    message: skipAi
                        ? `${modelSelection.failedModel.providerID}/${modelSelection.failedModel.modelID} failed\nAI analysis skipped (strictModelSelection enabled)`
                        : `${modelSelection.failedModel.providerID}/${modelSelection.failedModel.modelID} failed\nUsing ${modelSelection.modelInfo.providerID}/${modelSelection.modelInfo.modelID}`,
                    variant: "info",
                    duration: 5000
                }
            })
        } catch {
            // Ignore toast errors
        }
    }

    if (modelSelection.source === 'fallback' && config.strategies.onIdle.strictModelSelection) {
        logger.info("Skipping AI analysis (fallback model, strictModelSelection enabled)")
        return []
    }

    const { generateObject } = await import('ai')

    const sanitizedMessages = replacePrunedToolOutputs(messages, alreadyPrunedIds)

    const analysisPrompt = buildAnalysisPrompt(
        prunableToolCallIds,
        sanitizedMessages,
        alreadyPrunedIds,
        protectedToolCallIds
    )

    const result = await generateObject({
        model: modelSelection.model,
        schema: z.object({
            pruned_tool_call_ids: z.array(z.string()),
            reasoning: z.string(),
        }),
        prompt: analysisPrompt
    })

    const rawLlmPrunedIds = result.object.pruned_tool_call_ids
    const llmPrunedIds = rawLlmPrunedIds.filter(id =>
        prunableToolCallIds.includes(id)
    )

    // Always log LLM output as debug
    const reasoning = result.object.reasoning.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
    logger.debug(`OnIdle LLM output`, {
        pruned_tool_call_ids: rawLlmPrunedIds,
        reasoning: reasoning
    })

    return llmPrunedIds
}

/**
 * Run the onIdle pruning strategy.
 * This is called when the session transitions to idle state.
 */
export async function runOnIdle(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory?: string
): Promise<void | null> {
    try {
        if (!state.sessionId) {
            return null
        }

        const sessionId = state.sessionId

        // Fetch session info and messages
        const [sessionInfoResponse, messagesResponse] = await Promise.all([
            client.session.get({ path: { id: sessionId } }),
            client.session.messages({ path: { id: sessionId }})
        ])

        const sessionInfo = sessionInfoResponse.data
        const messages: WithParts[] = messagesResponse.data || messagesResponse

        if (!messages || messages.length < 3) {
            return null
        }

        const currentAgent = findCurrentAgent(messages)
        const { toolCallIds, toolMetadata } = parseMessages(messages, state.toolParameters)

        const alreadyPrunedIds = state.prune.toolIds
        const unprunedToolCallIds = toolCallIds.filter(id => !alreadyPrunedIds.includes(id))

        if (unprunedToolCallIds.length === 0) {
            return null
        }

        // Count prunable tools (excluding protected)
        const candidateCount = unprunedToolCallIds.filter(id => {
            const metadata = toolMetadata.get(id)
            return !metadata || !config.strategies.onIdle.protectedTools.includes(metadata.tool)
        }).length

        if (candidateCount === 0) {
            return null
        }

        // Run LLM analysis
        const llmPrunedIds = await runLlmAnalysis(
            client,
            state,
            logger,
            config,
            messages,
            unprunedToolCallIds,
            alreadyPrunedIds,
            toolMetadata,
            workingDirectory
        )

        const newlyPrunedIds = llmPrunedIds.filter(id => !alreadyPrunedIds.includes(id))

        if (newlyPrunedIds.length === 0) {
            return null
        }

        // Log the tool IDs being pruned with their tool names
        for (const id of newlyPrunedIds) {
            const metadata = toolMetadata.get(id)
            const toolName = metadata?.tool || 'unknown'
            logger.info(`OnIdle pruning tool: ${toolName}`, { callID: id })
        }

        // Update state
        const allPrunedIds = [...new Set([...alreadyPrunedIds, ...newlyPrunedIds])]
        state.prune.toolIds = allPrunedIds

        state.stats.pruneTokenCounter += calculateTokensSaved(messages, newlyPrunedIds)

        // Build tool metadata map for notification
        const prunedToolMetadata = new Map<string, ToolParameterEntry>()
        for (const id of newlyPrunedIds) {
            const metadata = toolMetadata.get(id)
            if (metadata) {
                prunedToolMetadata.set(id, metadata)
            }
        }

        // Send notification
        await sendUnifiedNotification(
            client,
            logger,
            config,
            state,
            sessionId,
            newlyPrunedIds,
            prunedToolMetadata,
            undefined, // reason
            currentAgent,
            workingDirectory || ""
        )

        state.stats.totalPruneTokens += state.stats.pruneTokenCounter
        state.stats.pruneTokenCounter = 0
        state.nudgeCounter = 0
        state.lastToolPrune = true

        // Persist state
        const sessionName = sessionInfo?.title
        saveSessionState(state, logger, sessionName).catch(err => {
            logger.error("Failed to persist state", { error: err.message })
        })

        logger.info(`OnIdle: Pruned ${newlyPrunedIds.length}/${candidateCount} tools`)
    } catch (error: any) {
        logger.error("OnIdle analysis failed", { error: error.message })
        return null
    }
}
