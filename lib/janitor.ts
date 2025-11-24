import { z } from "zod"
import type { Logger } from "./logger"
import type { StateManager } from "./state"
import { buildAnalysisPrompt } from "./prompt"
import { selectModel, extractModelFromSession } from "./model-selector"
import { estimateTokensBatch, formatTokenCount } from "./tokenizer"
import { detectDuplicates, extractParameterKey } from "./deduplicator"

export class Janitor {
    constructor(
        private client: any,
        private stateManager: StateManager,
        private logger: Logger,
        private toolParametersCache: Map<string, any>,
        private protectedTools: string[],
        private modelCache: Map<string, { providerID: string; modelID: string }>,
        private configModel?: string, // Format: "provider/model"
        private showModelErrorToasts: boolean = true, // Whether to show toast for model errors
        private pruningMode: "auto" | "smart" = "smart", // Pruning strategy
        private pruningSummary: "off" | "minimal" | "detailed" = "detailed" // UI summary display mode
    ) { }

    /**
     * Sends an ignored message to the session UI (user sees it, AI doesn't)
     */
    private async sendIgnoredMessage(sessionID: string, text: string) {
        try {
            await this.client.session.prompt({
                path: {
                    id: sessionID
                },
                body: {
                    noReply: true, // Don't wait for AI response
                    parts: [{
                        type: 'text',
                        text: text,
                        ignored: true
                    }]
                }
            })
            this.logger.debug("janitor", "Sent ignored message to session", {
                sessionID,
                textLength: text.length
            })
        } catch (error: any) {
            this.logger.error("janitor", "Failed to send ignored message", {
                sessionID,
                error: error.message
            })
            // Don't fail the operation if sending the message fails
        }
    }

    async run(sessionID: string) {
        this.logger.info("janitor", "Starting analysis", { sessionID })

        try {
            // Fetch session info and messages from OpenCode API
            this.logger.debug("janitor", "Fetching session info and messages", { sessionID })

            const [sessionInfoResponse, messagesResponse] = await Promise.all([
                this.client.session.get({ path: { id: sessionID } }),
                this.client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
            ])

            const sessionInfo = sessionInfoResponse.data
            // Handle the response format - it should be { data: Array<{info, parts}> } or just the array
            const messages = messagesResponse.data || messagesResponse

            this.logger.debug("janitor", "Retrieved messages", {
                sessionID,
                messageCount: messages.length
            })

            // If there are no messages or very few, skip analysis
            if (!messages || messages.length < 3) {
                this.logger.debug("janitor", "Too few messages to analyze, skipping", {
                    sessionID,
                    messageCount: messages?.length || 0
                })
                return
            }

            // Extract tool call IDs from the session and track their output sizes
            // Also track batch tool relationships and tool metadata
            const toolCallIds: string[] = []
            const toolOutputs = new Map<string, string>()
            const toolMetadata = new Map<string, { tool: string, parameters?: any }>() // callID -> {tool, parameters}
            const batchToolChildren = new Map<string, string[]>() // batchID -> [childIDs]
            let currentBatchId: string | null = null

            for (const msg of messages) {
                if (msg.parts) {
                    for (const part of msg.parts) {
                        if (part.type === "tool" && part.callID) {
                            // Normalize tool call IDs to lowercase for consistent comparison
                            const normalizedId = part.callID.toLowerCase()
                            toolCallIds.push(normalizedId)

                            // Try to get parameters from cache first, fall back to part.parameters
                            // Cache might have either case, so check both
                            const cachedData = this.toolParametersCache.get(part.callID) || this.toolParametersCache.get(normalizedId)
                            const parameters = cachedData?.parameters || part.parameters

                            // Track tool metadata (name and parameters)
                            toolMetadata.set(normalizedId, {
                                tool: part.tool,
                                parameters: parameters
                            })

                            // Debug: log what we're storing
                            if (normalizedId.startsWith('prt_') || part.tool === "read" || part.tool === "list") {
                                this.logger.debug("janitor", "Storing tool metadata", {
                                    sessionID,
                                    callID: normalizedId,
                                    tool: part.tool,
                                    hasParameters: !!parameters,
                                    hasCached: !!cachedData,
                                    parameters: parameters
                                })
                            }

                            // Track the output content for size calculation
                            if (part.state?.status === "completed" && part.state.output) {
                                toolOutputs.set(normalizedId, part.state.output)
                            }

                            // Check if this is a batch tool by looking at the tool name
                            if (part.tool === "batch") {
                                const batchId = normalizedId
                                currentBatchId = batchId
                                batchToolChildren.set(batchId, [])
                                this.logger.debug("janitor", "Found batch tool", {
                                    sessionID,
                                    batchID: currentBatchId
                                })
                            }
                            // If we're inside a batch and this is a prt_ (parallel) tool call, it's a child
                            else if (currentBatchId && normalizedId.startsWith('prt_')) {
                                const children = batchToolChildren.get(currentBatchId)!
                                children.push(normalizedId)
                                this.logger.debug("janitor", "Added child to batch tool", {
                                    sessionID,
                                    batchID: currentBatchId,
                                    childID: normalizedId,
                                    totalChildren: children.length
                                })
                            }
                            // If we hit a non-batch, non-prt_ tool, we're out of the batch
                            else if (currentBatchId && !normalizedId.startsWith('prt_')) {
                                this.logger.debug("janitor", "Batch tool ended", {
                                    sessionID,
                                    batchID: currentBatchId,
                                    totalChildren: batchToolChildren.get(currentBatchId)!.length
                                })
                                currentBatchId = null
                            }
                        }
                    }
                }
            }

            // Log summary of batch tools found
            if (batchToolChildren.size > 0) {
                this.logger.debug("janitor", "Batch tool summary", {
                    sessionID,
                    batchCount: batchToolChildren.size,
                    batches: Array.from(batchToolChildren.entries()).map(([id, children]) => ({
                        batchID: id,
                        childCount: children.length,
                        childIDs: children
                    }))
                })
            }

            // Get already pruned IDs to filter them out
            const alreadyPrunedIds = await this.stateManager.get(sessionID)
            const unprunedToolCallIds = toolCallIds.filter(id => !alreadyPrunedIds.includes(id))

            this.logger.debug("janitor", "Found tool calls in session", {
                sessionID,
                toolCallCount: toolCallIds.length,
                toolCallIds,
                alreadyPrunedCount: alreadyPrunedIds.length,
                alreadyPrunedIds: alreadyPrunedIds.slice(0, 5), // Show first 5 for brevity
                unprunedCount: unprunedToolCallIds.length
            })

            // If there are no unpruned tool calls, skip analysis
            if (unprunedToolCallIds.length === 0) {
                this.logger.debug("janitor", "No unpruned tool calls found, skipping analysis", {
                    sessionID
                })
                return
            }

            // ============================================================
            // PHASE 1: DUPLICATE DETECTION (runs for both modes)
            // ============================================================
            const dedupeResult = detectDuplicates(toolMetadata, unprunedToolCallIds, this.protectedTools)
            const deduplicatedIds = dedupeResult.duplicateIds
            const deduplicationDetails = dedupeResult.deduplicationDetails

            this.logger.info("janitor", "Duplicate detection complete", {
                sessionID,
                duplicatesFound: deduplicatedIds.length,
                uniqueToolPatterns: deduplicationDetails.size
            })

            // ============================================================
            // PHASE 2: LLM ANALYSIS (only runs in "smart" mode)
            // ============================================================
            let llmPrunedIds: string[] = []

            if (this.pruningMode === "smart") {
                // Filter out duplicates and protected tools
                const protectedToolCallIds: string[] = []
                const prunableToolCallIds = unprunedToolCallIds.filter(id => {
                    // Skip already deduplicated
                    if (deduplicatedIds.includes(id)) return false

                    // Skip protected tools
                    const metadata = toolMetadata.get(id)
                    if (metadata && this.protectedTools.includes(metadata.tool)) {
                        protectedToolCallIds.push(id)
                        return false
                    }

                    return true
                })

                if (protectedToolCallIds.length > 0) {
                    this.logger.debug("janitor", "Protected tools excluded from pruning", {
                        sessionID,
                        protectedCount: protectedToolCallIds.length,
                        protectedTools: protectedToolCallIds.map(id => {
                            const metadata = toolMetadata.get(id)
                            return { id, tool: metadata?.tool }
                        })
                    })
                }

                // Run LLM analysis only if there are prunable tools
                if (prunableToolCallIds.length > 0) {
                    this.logger.info("janitor", "Starting LLM analysis", {
                        sessionID,
                        candidateCount: prunableToolCallIds.length
                    })

                    // Select appropriate model with intelligent fallback
                    const cachedModelInfo = this.modelCache.get(sessionID)
                    const sessionModelInfo = extractModelFromSession(sessionInfo, this.logger)
                    const currentModelInfo = cachedModelInfo || sessionModelInfo

                    if (cachedModelInfo) {
                        this.logger.debug("janitor", "Using cached model info", {
                            sessionID,
                            providerID: cachedModelInfo.providerID,
                            modelID: cachedModelInfo.modelID
                        })
                    }

                    const modelSelection = await selectModel(currentModelInfo, this.logger, this.configModel)

                    this.logger.info("janitor", "Model selected for analysis", {
                        sessionID,
                        modelInfo: modelSelection.modelInfo,
                        source: modelSelection.source,
                        reason: modelSelection.reason
                    })

                    // Show toast if we had to fallback from a failed model
                    if (modelSelection.failedModel && this.showModelErrorToasts) {
                        try {
                            await this.client.tui.showToast({
                                body: {
                                    title: "DCP: Model fallback",
                                    message: `${modelSelection.failedModel.providerID}/${modelSelection.failedModel.modelID} failed\nUsing ${modelSelection.modelInfo.providerID}/${modelSelection.modelInfo.modelID}`,
                                    variant: "info",
                                    duration: 5000
                                }
                            })
                            this.logger.info("janitor", "Toast notification shown for model fallback", {
                                failedModel: modelSelection.failedModel,
                                selectedModel: modelSelection.modelInfo
                            })
                        } catch (toastError: any) {
                            this.logger.error("janitor", "Failed to show toast notification", {
                                error: toastError.message
                            })
                            // Don't fail the whole operation if toast fails
                        }
                    } else if (modelSelection.failedModel && !this.showModelErrorToasts) {
                        this.logger.info("janitor", "Model fallback occurred but toast disabled by config", {
                            failedModel: modelSelection.failedModel,
                            selectedModel: modelSelection.modelInfo
                        })
                    }

                    // Log comprehensive stats before AI call
                    this.logger.info("janitor", "Preparing AI analysis", {
                        sessionID,
                        totalToolCallsInSession: toolCallIds.length,
                        alreadyPrunedCount: alreadyPrunedIds.length,
                        deduplicatedCount: deduplicatedIds.length,
                        protectedToolsCount: protectedToolCallIds.length,
                        candidatesForPruning: prunableToolCallIds.length,
                        candidateTools: prunableToolCallIds.map(id => {
                            const meta = toolMetadata.get(id)
                            return meta ? `${meta.tool}[${id.substring(0, 12)}...]` : id.substring(0, 12) + '...'
                        }).slice(0, 10), // Show first 10 for brevity
                        batchToolCount: batchToolChildren.size,
                        batchDetails: Array.from(batchToolChildren.entries()).map(([batchId, children]) => ({
                            batchId: batchId.substring(0, 20) + '...',
                            childCount: children.length
                        }))
                    })

                    this.logger.debug("janitor", "Starting shadow inference", { sessionID })

                    // Replace already-pruned tool outputs to save tokens in janitor context
                    const allPrunedSoFar = [...alreadyPrunedIds, ...deduplicatedIds]
                    const sanitizedMessages = this.replacePrunedToolOutputs(messages, allPrunedSoFar)
                    
                    this.logger.debug("janitor", "Sanitized messages for analysis", {
                        sessionID,
                        totalPrunedBeforeAnalysis: allPrunedSoFar.length,
                        prunedIds: allPrunedSoFar.slice(0, 5) // Show first 5
                    })

                    // Lazy import - only load the 2.8MB ai package when actually needed
                    const { generateObject } = await import('ai')

                    // Analyze which tool calls are obsolete
                    const result = await generateObject({
                        model: modelSelection.model,
                        schema: z.object({
                            pruned_tool_call_ids: z.array(z.string()),
                            reasoning: z.string(),
                        }),
                        prompt: buildAnalysisPrompt(prunableToolCallIds, sanitizedMessages, this.protectedTools, allPrunedSoFar, protectedToolCallIds)
                    })

                    // Filter LLM results to only include IDs that were actually candidates
                    // (LLM sometimes returns duplicate IDs that were already filtered out)
                    const rawLlmPrunedIds = result.object.pruned_tool_call_ids
                    llmPrunedIds = rawLlmPrunedIds.filter(id => 
                        prunableToolCallIds.includes(id.toLowerCase())
                    )

                    if (rawLlmPrunedIds.length !== llmPrunedIds.length) {
                        this.logger.warn("janitor", "LLM returned non-candidate IDs (filtered out)", {
                            sessionID,
                            rawCount: rawLlmPrunedIds.length,
                            filteredCount: llmPrunedIds.length,
                            invalidIds: rawLlmPrunedIds.filter(id => !prunableToolCallIds.includes(id.toLowerCase()))
                        })
                    }

                    this.logger.info("janitor", "LLM analysis complete", {
                        sessionID,
                        llmPrunedCount: llmPrunedIds.length,
                        reasoning: result.object.reasoning
                    })
                } else {
                    this.logger.info("janitor", "No prunable tools for LLM analysis", {
                        sessionID,
                        deduplicatedCount: deduplicatedIds.length,
                        protectedCount: protectedToolCallIds.length
                    })
                }
            } else {
                this.logger.info("janitor", "Skipping LLM analysis (auto mode)", {
                    sessionID,
                    deduplicatedCount: deduplicatedIds.length
                })
            }
            // If mode is "auto", llmPrunedIds stays empty

            // ============================================================
            // PHASE 3: COMBINE & EXPAND
            // ============================================================
            const newlyPrunedIds = [...deduplicatedIds, ...llmPrunedIds]

            if (newlyPrunedIds.length === 0) {
                this.logger.info("janitor", "No tools to prune", { sessionID })
                return
            }

            // Expand batch tool IDs to include their children
            const expandedPrunedIds = new Set<string>()
            for (const prunedId of newlyPrunedIds) {
                const normalizedId = prunedId.toLowerCase()
                expandedPrunedIds.add(normalizedId)

                // If this is a batch tool, add all its children
                const children = batchToolChildren.get(normalizedId)
                if (children) {
                    this.logger.debug("janitor", "Expanding batch tool to include children", {
                        sessionID,
                        batchID: normalizedId,
                        childCount: children.length,
                        childIDs: children
                    })
                    children.forEach(childId => expandedPrunedIds.add(childId))
                }
            }

            // Calculate which IDs are actually NEW (not already pruned)
            const finalNewlyPrunedIds = Array.from(expandedPrunedIds).filter(id => !alreadyPrunedIds.includes(id))
            
            // finalPrunedIds includes everything (new + already pruned) for logging
            const finalPrunedIds = Array.from(expandedPrunedIds)

            this.logger.info("janitor", "Analysis complete", {
                sessionID,
                prunedCount: finalPrunedIds.length,
                deduplicatedCount: deduplicatedIds.length,
                llmPrunedCount: llmPrunedIds.length,
                prunedIds: finalPrunedIds
            })

            this.logger.debug("janitor", "Pruning ID details", {
                sessionID,
                alreadyPrunedCount: alreadyPrunedIds.length,
                alreadyPrunedIds: alreadyPrunedIds,
                finalPrunedCount: finalPrunedIds.length,
                finalPrunedIds: finalPrunedIds,
                newlyPrunedCount: finalNewlyPrunedIds.length,
                newlyPrunedIds: finalNewlyPrunedIds
            })

            // ============================================================
            // PHASE 4: NOTIFICATION
            // ============================================================
            if (this.pruningMode === "auto") {
                await this.sendAutoModeNotification(
                    sessionID,
                    deduplicatedIds,
                    deduplicationDetails,
                    toolOutputs
                )
            } else {
                await this.sendSmartModeNotification(
                    sessionID,
                    deduplicatedIds,
                    deduplicationDetails,
                    llmPrunedIds,
                    toolMetadata,
                    toolOutputs
                )
            }

            // ============================================================
            // PHASE 5: STATE UPDATE
            // ============================================================
            // Merge newly pruned IDs with existing ones (using expanded IDs)
            const allPrunedIds = [...new Set([...alreadyPrunedIds, ...finalPrunedIds])]
            await this.stateManager.set(sessionID, allPrunedIds)
            this.logger.debug("janitor", "Updated state manager", {
                sessionID,
                totalPrunedCount: allPrunedIds.length,
                newlyPrunedCount: finalNewlyPrunedIds.length
            })

        } catch (error: any) {
            this.logger.error("janitor", "Analysis failed", {
                sessionID,
                error: error.message,
                stack: error.stack
            })
            // Don't throw - this is a fire-and-forget background process
            // Silently fail and try again on next idle event
        }
    }

    /**
     * Helper function to shorten paths for display
     */
    private shortenPath(path: string): string {
        // Replace home directory with ~
        const homeDir = require('os').homedir()
        if (path.startsWith(homeDir)) {
            path = '~' + path.slice(homeDir.length)
        }

        // Shorten node_modules paths: show package + file only
        const nodeModulesMatch = path.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)\/(.*)/)
        if (nodeModulesMatch) {
            return `${nodeModulesMatch[1]}/${nodeModulesMatch[2]}`
        }

        return path
    }

    /**
     * Replace pruned tool outputs with placeholder text to save tokens in janitor context
     * This applies the same replacement logic as the global fetch wrapper, but for the
     * janitor's shadow inference to avoid sending already-pruned content to the LLM
     */
    private replacePrunedToolOutputs(messages: any[], prunedIds: string[]): any[] {
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
                        // Replace with the same placeholder used by the global fetch wrapper
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

    /**
     * Helper function to calculate token savings from tool outputs
     */
    private async calculateTokensSaved(prunedIds: string[], toolOutputs: Map<string, string>): Promise<number> {
        const outputsToTokenize: string[] = []
        
        for (const prunedId of prunedIds) {
            const output = toolOutputs.get(prunedId)
            if (output) {
                outputsToTokenize.push(output)
            }
        }
        
        if (outputsToTokenize.length > 0) {
            // Use batch tokenization for efficiency (lazy loads gpt-tokenizer)
            const tokenCounts = await estimateTokensBatch(outputsToTokenize, this.logger)
            return tokenCounts.reduce((sum, count) => sum + count, 0)
        }
        
        return 0
    }

    /**
     * Build a summary of tools by grouping them
     * Uses shared extractParameterKey logic for consistent parameter extraction
     */
    private buildToolsSummary(prunedIds: string[], toolMetadata: Map<string, { tool: string, parameters?: any }>): Map<string, string[]> {
        const toolsSummary = new Map<string, string[]>()

        // Helper function to truncate long strings
        const truncate = (str: string, maxLen: number = 60): string => {
            if (str.length <= maxLen) return str
            return str.slice(0, maxLen - 3) + '...'
        }

        for (const prunedId of prunedIds) {
            const metadata = toolMetadata.get(prunedId)
            if (metadata) {
                const toolName = metadata.tool
                if (!toolsSummary.has(toolName)) {
                    toolsSummary.set(toolName, [])
                }

                // Use shared parameter extraction logic
                const paramKey = extractParameterKey(metadata)
                if (paramKey) {
                    // Apply path shortening and truncation for display
                    const displayKey = truncate(this.shortenPath(paramKey), 80)
                    toolsSummary.get(toolName)!.push(displayKey)
                }
            }
        }

        return toolsSummary
    }

    /**
     * Send minimal summary notification (just tokens saved and count)
     */
    private async sendMinimalNotification(
        sessionID: string,
        totalPruned: number,
        toolOutputs: Map<string, string>,
        prunedIds: string[]
    ) {
        if (totalPruned === 0) return

        const tokensSaved = await this.calculateTokensSaved(prunedIds, toolOutputs)
        const tokensFormatted = formatTokenCount(tokensSaved)
        const toolText = totalPruned === 1 ? 'tool' : 'tools'

        const message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${totalPruned} ${toolText} pruned)`

        await this.sendIgnoredMessage(sessionID, message)
    }

    /**
     * Auto mode notification - shows only deduplication results
     */
    private async sendAutoModeNotification(
        sessionID: string,
        deduplicatedIds: string[],
        deduplicationDetails: Map<string, any>,
        toolOutputs: Map<string, string>
    ) {
        if (deduplicatedIds.length === 0) return

        // Check if notifications are disabled
        if (this.pruningSummary === 'off') return

        // Send minimal notification if configured
        if (this.pruningSummary === 'minimal') {
            await this.sendMinimalNotification(sessionID, deduplicatedIds.length, toolOutputs, deduplicatedIds)
            return
        }

        // Otherwise send detailed notification
        // Calculate token savings
        const tokensSaved = await this.calculateTokensSaved(deduplicatedIds, toolOutputs)
        const tokensFormatted = formatTokenCount(tokensSaved)

        const toolText = deduplicatedIds.length === 1 ? 'tool' : 'tools'
        let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${deduplicatedIds.length} duplicate ${toolText} removed)\n`

        // Group by tool type
        const grouped = new Map<string, Array<{count: number, key: string}>>()

        for (const [_, details] of deduplicationDetails) {
            const { toolName, parameterKey, duplicateCount } = details
            if (!grouped.has(toolName)) {
                grouped.set(toolName, [])
            }
            grouped.get(toolName)!.push({
                count: duplicateCount,
                key: this.shortenPath(parameterKey)
            })
        }

        // Display grouped results
        for (const [toolName, items] of grouped.entries()) {
            const totalDupes = items.reduce((sum, item) => sum + (item.count - 1), 0)
            message += `\n${toolName} (${totalDupes} duplicate${totalDupes > 1 ? 's' : ''}):\n`

            for (const item of items.slice(0, 5)) {
                const dupeCount = item.count - 1
                message += `  ${item.key} (${dupeCount}× duplicate)\n`
            }

            if (items.length > 5) {
                message += `  ... and ${items.length - 5} more\n`
            }
        }

        await this.sendIgnoredMessage(sessionID, message.trim())
    }

    /**
     * Smart mode notification - shows both deduplication and LLM analysis results
     */
    private async sendSmartModeNotification(
        sessionID: string,
        deduplicatedIds: string[],
        deduplicationDetails: Map<string, any>,
        llmPrunedIds: string[],
        toolMetadata: Map<string, any>,
        toolOutputs: Map<string, string>
    ) {
        const totalPruned = deduplicatedIds.length + llmPrunedIds.length
        if (totalPruned === 0) return

        // Check if notifications are disabled
        if (this.pruningSummary === 'off') return

        // Send minimal notification if configured
        if (this.pruningSummary === 'minimal') {
            const allPrunedIds = [...deduplicatedIds, ...llmPrunedIds]
            await this.sendMinimalNotification(sessionID, totalPruned, toolOutputs, allPrunedIds)
            return
        }

        // Otherwise send detailed notification
        // Calculate token savings
        const allPrunedIds = [...deduplicatedIds, ...llmPrunedIds]
        const tokensSaved = await this.calculateTokensSaved(allPrunedIds, toolOutputs)
        const tokensFormatted = formatTokenCount(tokensSaved)

        let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${totalPruned} tool${totalPruned > 1 ? 's' : ''} pruned)\n`

        // Section 1: Deduplicated tools
        if (deduplicatedIds.length > 0 && deduplicationDetails) {
            message += `\n📦 Duplicates removed (${deduplicatedIds.length}):\n`

            // Group by tool type
            const grouped = new Map<string, Array<{count: number, key: string}>>()

            for (const [_, details] of deduplicationDetails) {
                const { toolName, parameterKey, duplicateCount } = details
                if (!grouped.has(toolName)) {
                    grouped.set(toolName, [])
                }
                grouped.get(toolName)!.push({
                    count: duplicateCount,
                    key: this.shortenPath(parameterKey)
                })
            }

            for (const [toolName, items] of grouped.entries()) {
                message += `  ${toolName}:\n`
                for (const item of items) {
                    const removedCount = item.count - 1  // Total occurrences minus the one we kept
                    message += `    ${item.key} (${removedCount}× duplicate)\n`
                }
            }
        }

        // Section 2: LLM-pruned tools
        if (llmPrunedIds.length > 0) {
            message += `\n🤖 LLM analysis (${llmPrunedIds.length}):\n`

            // Use buildToolsSummary logic
            const toolsSummary = this.buildToolsSummary(llmPrunedIds, toolMetadata)

            for (const [toolName, params] of toolsSummary.entries()) {
                if (params.length > 0) {
                    message += `  ${toolName} (${params.length}):\n`
                    for (const param of params) {
                        message += `    ${param}\n`
                    }
                } else {
                    // For tools with no specific params (like batch), just show the tool name and count
                    const count = llmPrunedIds.filter(id => {
                        const m = toolMetadata.get(id)
                        return m && m.tool === toolName
                    }).length
                    if (count > 0) {
                        message += `  ${toolName} (${count})\n`
                    }
                }
            }
        }

        await this.sendIgnoredMessage(sessionID, message.trim())
    }
}
