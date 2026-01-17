/**
 * Preemptive Compaction Handler
 * 
 * Multi-phase compaction that attempts DCP strategies + truncation before
 * falling back to expensive summarization.
 * 
 * Flow:
 * 1. Check if usage >= threshold
 * 2. Phase 1: Run DCP strategies (deduplication, supersede writes, purge errors)
 * 3. Phase 2: Truncate large tool outputs (protect recent messages)
 * 4. Decision: If usage < threshold, skip summarization
 * 5. Fallback: Trigger summarize() if still over threshold
 */

import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { SessionState } from "../state"
import type { PreemptiveCompactionState, MessageInfo, TokenInfo } from "./types"
import { MIN_TOKENS_FOR_COMPACTION, CHARS_PER_TOKEN } from "./constants"
import { inferContextLimit } from "./model-limits"
import { truncateUntilTargetTokens } from "./storage"

// Re-export types for external use
export type { PreemptiveCompactionConfig, MessageInfo } from "./types"

/**
 * Create the preemptive compaction state
 */
function createState(): PreemptiveCompactionState {
    return {
        lastCompactionTime: new Map(),
        compactionInProgress: new Set(),
    }
}

/**
 * Create the preemptive compaction event handler
 */
export function createPreemptiveCompactionHandler(
    client: any,
    directory: string,
    dcpState: SessionState,
    logger: Logger,
    config: PluginConfig
) {
    const preemptiveConfig = config.preemptiveCompaction
    
    // Not enabled - return no-op handler
    if (!preemptiveConfig.enabled) {
        return async () => {}
    }

    const state = createState()
    const threshold = preemptiveConfig.threshold
    const cooldownMs = preemptiveConfig.cooldownMs
    const minTokens = preemptiveConfig.minTokens

    logger.info("Preemptive compaction initialized", {
        threshold,
        cooldownMs,
        minTokens,
        truncation: preemptiveConfig.truncation,
    })

    /**
     * Check and trigger compaction if needed
     */
    const checkAndTriggerCompaction = async (
        sessionID: string,
        lastAssistant: MessageInfo
    ): Promise<void> => {
        // Skip if already compacting this session
        if (state.compactionInProgress.has(sessionID)) {
            logger.debug("Compaction already in progress", { sessionID })
            return
        }

        // Check cooldown
        const lastCompaction = state.lastCompactionTime.get(sessionID) ?? 0
        if (Date.now() - lastCompaction < cooldownMs) {
            logger.debug("Compaction on cooldown", { sessionID })
            return
        }

        // Skip if this is a summary message
        if (lastAssistant.summary === true) {
            logger.debug("Skipping summary message", { sessionID })
            return
        }

        // Get token info
        const tokens = lastAssistant.tokens
        if (!tokens) {
            logger.debug("No token info available", { sessionID })
            return
        }

        const modelID = lastAssistant.modelID ?? ""
        const providerID = lastAssistant.providerID ?? ""

        // Infer context limit from model ID
        const contextLimit = inferContextLimit(modelID)
        const totalUsed = tokens.input + tokens.cache.read + tokens.output

        // Skip if not enough tokens
        if (totalUsed < minTokens) {
            logger.debug("Below minimum tokens threshold", { sessionID, totalUsed, minTokens })
            return
        }

        let usageRatio = totalUsed / contextLimit

        logger.info("Checking preemptive compaction", {
            sessionID,
            totalUsed,
            contextLimit,
            usageRatio: usageRatio.toFixed(2),
            threshold,
        })

        // Skip if under threshold
        if (usageRatio < threshold) {
            return
        }

        // Mark compaction in progress
        state.compactionInProgress.add(sessionID)
        state.lastCompactionTime.set(sessionID, Date.now())

        // Validate provider/model info
        if (!providerID || !modelID) {
            logger.warn("Missing provider/model info", { sessionID })
            state.compactionInProgress.delete(sessionID)
            return
        }

        try {
            // Show initial toast
            await client.tui.showToast({
                body: {
                    title: "Smart Compaction",
                    message: `Context at ${(usageRatio * 100).toFixed(0)}% - running DCP + truncation...`,
                    variant: "warning",
                    duration: 3000,
                },
            }).catch(() => {})

            let tokensSaved = 0

            // Phase 1: DCP is already running via message transform
            // The strategies (deduplication, supersede writes, purge errors) run automatically
            // on each message transform. Here we just log that DCP is active.
            logger.info("Phase 1: DCP strategies active via message transform", { sessionID })

            // Phase 2: Truncation
            if (preemptiveConfig.truncation.enabled) {
                logger.info("Phase 2: Running truncation", { sessionID })

                const protectedMessages = preemptiveConfig.truncation.protectedMessages
                const truncationResult = truncateUntilTargetTokens(
                    sessionID,
                    totalUsed - tokensSaved,
                    contextLimit,
                    threshold,
                    CHARS_PER_TOKEN,
                    protectedMessages
                )

                if (truncationResult.truncatedCount > 0) {
                    const truncationTokensSaved = Math.floor(
                        truncationResult.totalBytesRemoved / CHARS_PER_TOKEN
                    )
                    tokensSaved += truncationTokensSaved

                    logger.info("Truncation completed", {
                        sessionID,
                        truncatedCount: truncationResult.truncatedCount,
                        bytesRemoved: truncationResult.totalBytesRemoved,
                        tokensSaved: truncationTokensSaved,
                        tools: truncationResult.truncatedTools.map((t) => t.toolName),
                    })
                } else {
                    logger.info("Truncation completed - nothing to truncate", { sessionID })
                }
            }

            // Recalculate usage
            const currentTokens = totalUsed - tokensSaved
            usageRatio = currentTokens / contextLimit

            logger.info("After DCP + Truncation", {
                sessionID,
                originalTokens: totalUsed,
                tokensSaved,
                currentTokens,
                newUsageRatio: usageRatio.toFixed(2),
                threshold,
            })

            // Decision: Skip summarization if under threshold
            if (usageRatio < threshold) {
                await client.tui.showToast({
                    body: {
                        title: "Smart Compaction Success",
                        message: `Reduced to ${(usageRatio * 100).toFixed(0)}% via DCP + truncation. No summarization needed.`,
                        variant: "success",
                        duration: 4000,
                    },
                }).catch(() => {})

                logger.info("Skipping summarization - pruning was sufficient", {
                    sessionID,
                    tokensSaved,
                    newUsageRatio: usageRatio.toFixed(2),
                })

                state.compactionInProgress.delete(sessionID)
                return
            }

            // Fallback: Trigger summarization
            await client.tui.showToast({
                body: {
                    title: "Smart Compaction",
                    message: `Still at ${(usageRatio * 100).toFixed(0)}% after pruning. Summarizing...`,
                    variant: "warning",
                    duration: 3000,
                },
            }).catch(() => {})

            logger.info("Triggering summarization", { sessionID, usageRatio })

            const summarizeBody = { providerID, modelID, auto: true }
            await client.session.summarize({
                path: { id: sessionID },
                body: summarizeBody as never,
                query: { directory },
            })

            await client.tui.showToast({
                body: {
                    title: "Compaction Complete",
                    message: "Session compacted successfully.",
                    variant: "success",
                    duration: 2000,
                },
            }).catch(() => {})

            logger.info("Summarization completed", { sessionID })

        } catch (err) {
            logger.error("Compaction failed", { sessionID, error: String(err) })
        } finally {
            state.compactionInProgress.delete(sessionID)
        }
    }

    /**
     * Event handler for message.updated and session.deleted events
     */
    return async ({ event }: { event: { type: string; properties?: unknown } }) => {
        const props = event.properties as Record<string, unknown> | undefined

        // Handle session deletion - cleanup state
        if (event.type === "session.deleted") {
            const sessionInfo = props?.info as { id?: string } | undefined
            if (sessionInfo?.id) {
                state.lastCompactionTime.delete(sessionInfo.id)
                state.compactionInProgress.delete(sessionInfo.id)
                logger.debug("Cleaned up session state", { sessionID: sessionInfo.id })
            }
            return
        }

        // Handle message updated - check for compaction
        if (event.type === "message.updated") {
            const info = props?.info as MessageInfo | undefined
            if (!info) return

            // Only process finished assistant messages
            if (info.role !== "assistant" || !info.finish) return

            const sessionID = info.sessionID
            if (!sessionID) return

            await checkAndTriggerCompaction(sessionID, info)
            return
        }
    }
}
