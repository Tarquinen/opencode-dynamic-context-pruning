import { z } from "zod"
import type { Logger } from "../logger"
import type { PruningStrategy } from "../config"
import type { PluginState } from "../state"
import { buildAnalysisPrompt } from "./prompt"
import { selectModel, extractModelFromSession } from "../model-selector"
import { estimateTokensBatch, formatTokenCount } from "../tokenizer"
import { saveSessionState } from "../state/persistence"
import { ensureSessionRestored } from "../state"
import {
    sendUnifiedNotification,
    type NotificationContext
} from "../ui/notification"

export interface SessionStats {
    totalToolsPruned: number
    totalTokensSaved: number
    totalGCTokens: number
}

export interface GCStats {
    tokensCollected: number
    toolsDeduped: number
}

export interface PruningResult {
    prunedCount: number
    tokensSaved: number
    llmPrunedIds: string[]
    toolMetadata: Map<string, { tool: string, parameters?: any }>
    sessionStats: SessionStats
}

export interface PruningOptions {
    reason?: string
    trigger: 'idle' | 'tool'
}

export interface JanitorConfig {
    protectedTools: string[]
    model?: string
    showModelErrorToasts: boolean
    strictModelSelection: boolean
    pruningSummary: "off" | "minimal" | "detailed"
    workingDirectory?: string
}

export interface JanitorContext {
    client: any
    state: PluginState
    logger: Logger
    config: JanitorConfig
    notificationCtx: NotificationContext
}

// ============================================================================
// Context factory
// ============================================================================

export function createJanitorContext(
    client: any,
    state: PluginState,
    logger: Logger,
    config: JanitorConfig
): JanitorContext {
    return {
        client,
        state,
        logger,
        config,
        notificationCtx: {
            client,
            logger,
            config: {
                pruningSummary: config.pruningSummary,
                workingDirectory: config.workingDirectory
            }
        }
    }
}

// ============================================================================
// Public API
// ============================================================================

export async function runOnIdle(
    ctx: JanitorContext,
    sessionID: string,
    strategies: PruningStrategy[]
): Promise<PruningResult | null> {
    return runWithStrategies(ctx, sessionID, strategies, { trigger: 'idle' })
}

export async function runOnTool(
    ctx: JanitorContext,
    sessionID: string,
    strategies: PruningStrategy[],
    reason?: string
): Promise<PruningResult | null> {
    return runWithStrategies(ctx, sessionID, strategies, { trigger: 'tool', reason })
}

// ============================================================================
// Core pruning logic
// ============================================================================

async function runWithStrategies(
    ctx: JanitorContext,
    sessionID: string,
    strategies: PruningStrategy[],
    options: PruningOptions
): Promise<PruningResult | null> {
    const { client, state, logger, config } = ctx

    try {
        if (strategies.length === 0) {
            return null
        }

        // Ensure persisted state is restored before processing
        await ensureSessionRestored(state, sessionID, logger)

        const [sessionInfoResponse, messagesResponse] = await Promise.all([
            client.session.get({ path: { id: sessionID } }),
            client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
        ])

        const sessionInfo = sessionInfoResponse.data
        const messages = messagesResponse.data || messagesResponse

        if (!messages || messages.length < 3) {
            return null
        }

        const currentAgent = findCurrentAgent(messages)
        const { toolCallIds, toolOutputs, toolMetadata } = parseMessages(messages, state.toolParameters)

        const alreadyPrunedIds = state.prunedIds.get(sessionID) ?? []
        const unprunedToolCallIds = toolCallIds.filter(id => !alreadyPrunedIds.includes(id))

        // Get pending GC stats (accumulated since last notification)
        const gcPending = state.gcPending.get(sessionID) ?? null

        // If nothing to analyze and no GC activity, exit early
        if (unprunedToolCallIds.length === 0 && !gcPending) {
            return null
        }

        const candidateCount = unprunedToolCallIds.filter(id => {
            const metadata = toolMetadata.get(id)
            return !metadata || !config.protectedTools.includes(metadata.tool)
        }).length

        // PHASE 1: LLM ANALYSIS
        let llmPrunedIds: string[] = []

        if (strategies.includes('ai-analysis') && unprunedToolCallIds.length > 0) {
            llmPrunedIds = await runLlmAnalysis(
                ctx,
                sessionID,
                sessionInfo,
                messages,
                unprunedToolCallIds,
                alreadyPrunedIds,
                toolMetadata,
                options
            )
        }

        const finalNewlyPrunedIds = llmPrunedIds.filter(id => !alreadyPrunedIds.includes(id))

        // If AI pruned nothing and no GC activity, nothing to report
        if (finalNewlyPrunedIds.length === 0 && !gcPending) {
            return null
        }

        // PHASE 2: CALCULATE STATS & NOTIFICATION
        const tokensSaved = await calculateTokensSaved(finalNewlyPrunedIds, toolOutputs)

        // Get current session stats, initializing with proper defaults
        const currentStats = state.stats.get(sessionID) ?? {
            totalToolsPruned: 0,
            totalTokensSaved: 0,
            totalGCTokens: 0
        }

        // Update session stats including GC contribution
        const sessionStats: SessionStats = {
            totalToolsPruned: currentStats.totalToolsPruned + finalNewlyPrunedIds.length,
            totalTokensSaved: currentStats.totalTokensSaved + tokensSaved,
            totalGCTokens: currentStats.totalGCTokens + (gcPending?.tokensCollected ?? 0)
        }
        state.stats.set(sessionID, sessionStats)

        // Send unified notification (handles all scenarios)
        const notificationSent = await sendUnifiedNotification(
            ctx.notificationCtx,
            sessionID,
            {
                aiPrunedCount: llmPrunedIds.length,
                aiTokensSaved: tokensSaved,
                aiPrunedIds: llmPrunedIds,
                toolMetadata,
                gcPending,
                sessionStats
            },
            currentAgent
        )

        // Clear pending GC stats after notification (whether sent or not - we've consumed them)
        if (gcPending) {
            state.gcPending.delete(sessionID)
        }

        // If we only had GC activity (no AI pruning), return null but notification was sent
        if (finalNewlyPrunedIds.length === 0) {
            if (notificationSent) {
                logger.info("janitor", `GC-only notification: ~${formatTokenCount(gcPending?.tokensCollected ?? 0)} tokens from ${gcPending?.toolsDeduped ?? 0} deduped tools`, {
                    trigger: options.trigger
                })
            }
            return null
        }

        // PHASE 3: STATE UPDATE (only if AI pruned something)
        const allPrunedIds = [...new Set([...alreadyPrunedIds, ...llmPrunedIds])]
        state.prunedIds.set(sessionID, allPrunedIds)

        const sessionName = sessionInfo?.title
        saveSessionState(sessionID, new Set(allPrunedIds), sessionStats, logger, sessionName).catch(err => {
            logger.error("janitor", "Failed to persist state", { error: err.message })
        })

        const prunedCount = finalNewlyPrunedIds.length
        const keptCount = candidateCount - prunedCount

        const logMeta: Record<string, any> = { trigger: options.trigger }
        if (options.reason) {
            logMeta.reason = options.reason
        }
        if (gcPending) {
            logMeta.gcTokens = gcPending.tokensCollected
            logMeta.gcTools = gcPending.toolsDeduped
        }

        logger.info("janitor", `Pruned ${prunedCount}/${candidateCount} tools, ${keptCount} kept (~${formatTokenCount(tokensSaved)} tokens)`, logMeta)

        return {
            prunedCount: finalNewlyPrunedIds.length,
            tokensSaved,
            llmPrunedIds,
            toolMetadata,
            sessionStats
        }

    } catch (error: any) {
        ctx.logger.error("janitor", "Analysis failed", {
            error: error.message,
            trigger: options.trigger
        })
        return null
    }
}

// ============================================================================
// LLM Analysis
// ============================================================================

async function runLlmAnalysis(
    ctx: JanitorContext,
    sessionID: string,
    sessionInfo: any,
    messages: any[],
    unprunedToolCallIds: string[],
    alreadyPrunedIds: string[],
    toolMetadata: Map<string, { tool: string, parameters?: any }>,
    options: PruningOptions
): Promise<string[]> {
    const { client, state, logger, config } = ctx

    const protectedToolCallIds: string[] = []
    const prunableToolCallIds = unprunedToolCallIds.filter(id => {
        const metadata = toolMetadata.get(id)
        if (metadata && config.protectedTools.includes(metadata.tool)) {
            protectedToolCallIds.push(id)
            return false
        }
        return true
    })

    if (prunableToolCallIds.length === 0) {
        return []
    }

    const cachedModelInfo = state.model.get(sessionID)
    const sessionModelInfo = extractModelFromSession(sessionInfo, logger)
    const currentModelInfo = cachedModelInfo || sessionModelInfo

    const modelSelection = await selectModel(currentModelInfo, logger, config.model, config.workingDirectory)

    logger.info("janitor", `Model: ${modelSelection.modelInfo.providerID}/${modelSelection.modelInfo.modelID}`, {
        source: modelSelection.source
    })

    if (modelSelection.failedModel && config.showModelErrorToasts) {
        const skipAi = modelSelection.source === 'fallback' && config.strictModelSelection
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
        } catch (toastError: any) {
            // Ignore toast errors
        }
    }

    if (modelSelection.source === 'fallback' && config.strictModelSelection) {
        logger.info("janitor", "Skipping AI analysis (fallback model, strictModelSelection enabled)")
        return []
    }

    const { generateObject } = await import('ai')

    const sanitizedMessages = replacePrunedToolOutputs(messages, alreadyPrunedIds)

    const analysisPrompt = buildAnalysisPrompt(
        prunableToolCallIds,
        sanitizedMessages,
        alreadyPrunedIds,
        protectedToolCallIds,
        options.reason
    )

    await logger.saveWrappedContext(
        "janitor-shadow",
        [{ role: "user", content: analysisPrompt }],
        {
            sessionID,
            modelProvider: modelSelection.modelInfo.providerID,
            modelID: modelSelection.modelInfo.modelID,
            candidateToolCount: prunableToolCallIds.length,
            alreadyPrunedCount: alreadyPrunedIds.length,
            protectedToolCount: protectedToolCallIds.length,
            trigger: options.trigger,
            reason: options.reason
        }
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
        prunableToolCallIds.includes(id.toLowerCase())
    )

    if (llmPrunedIds.length > 0) {
        const reasoning = result.object.reasoning.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
        logger.info("janitor", `LLM reasoning: ${reasoning.substring(0, 200)}${reasoning.length > 200 ? '...' : ''}`)
    }

    return llmPrunedIds
}

// ============================================================================
// Message parsing
// ============================================================================

interface ParsedMessages {
    toolCallIds: string[]
    toolOutputs: Map<string, string>
    toolMetadata: Map<string, { tool: string, parameters?: any }>
}

function parseMessages(
    messages: any[],
    toolParametersCache: Map<string, any>
): ParsedMessages {
    const toolCallIds: string[] = []
    const toolOutputs = new Map<string, string>()
    const toolMetadata = new Map<string, { tool: string, parameters?: any }>()

    for (const msg of messages) {
        if (msg.parts) {
            for (const part of msg.parts) {
                if (part.type === "tool" && part.callID) {
                    const normalizedId = part.callID.toLowerCase()
                    toolCallIds.push(normalizedId)

                    const cachedData = toolParametersCache.get(part.callID) || toolParametersCache.get(normalizedId)
                    const parameters = cachedData?.parameters ?? part.state?.input ?? part.parameters

                    toolMetadata.set(normalizedId, {
                        tool: part.tool,
                        parameters: parameters
                    })

                    if (part.state?.status === "completed" && part.state.output) {
                        toolOutputs.set(normalizedId, part.state.output)
                    }
                }
            }
        }
    }

    return { toolCallIds, toolOutputs, toolMetadata }
}

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

// ============================================================================
// Helpers
// ============================================================================

function replacePrunedToolOutputs(messages: any[], prunedIds: string[]): any[] {
    if (prunedIds.length === 0) return messages

    const prunedIdsSet = new Set(prunedIds.map(id => id.toLowerCase()))

    return messages.map(msg => {
        if (!msg.parts) return msg

        return {
            ...msg,
            parts: msg.parts.map((part: any) => {
                if (part.type === 'tool' &&
                    part.callID &&
                    prunedIdsSet.has(part.callID.toLowerCase()) &&
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
    })
}

async function calculateTokensSaved(prunedIds: string[], toolOutputs: Map<string, string>): Promise<number> {
    const outputsToTokenize: string[] = []

    for (const prunedId of prunedIds) {
        const output = toolOutputs.get(prunedId)
        if (output) {
            outputsToTokenize.push(output)
        }
    }

    if (outputsToTokenize.length > 0) {
        const tokenCounts = await estimateTokensBatch(outputsToTokenize)
        return tokenCounts.reduce((sum, count) => sum + count, 0)
    }

    return 0
}
