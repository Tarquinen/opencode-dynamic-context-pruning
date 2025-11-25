import { z } from "zod"
import type { Logger } from "./logger"
import { buildAnalysisPrompt } from "./prompt"
import { selectModel, extractModelFromSession } from "./model-selector"
import { estimateTokensBatch, formatTokenCount } from "./tokenizer"
import { detectDuplicates, extractParameterKey } from "./deduplicator"

export interface SessionStats {
    totalToolsPruned: number
    totalTokensSaved: number
}

export class Janitor {
    constructor(
        private client: any,
        private prunedIdsState: Map<string, string[]>,
        private statsState: Map<string, SessionStats>,
        private logger: Logger,
        private toolParametersCache: Map<string, any>,
        private protectedTools: string[],
        private modelCache: Map<string, { providerID: string; modelID: string }>,
        private configModel?: string, // Format: "provider/model"
        private showModelErrorToasts: boolean = true, // Whether to show toast for model errors
        private pruningMode: "auto" | "smart" = "smart", // Pruning strategy
        private pruningSummary: "off" | "minimal" | "detailed" = "detailed", // UI summary display mode
        private workingDirectory?: string // Current working directory for relative path display
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
        } catch (error: any) {
            this.logger.error("janitor", "Failed to send notification", {
                error: error.message
            })
        }
    }

    async run(sessionID: string) {
        try {
            // Fetch session info and messages from OpenCode API
            const [sessionInfoResponse, messagesResponse] = await Promise.all([
                this.client.session.get({ path: { id: sessionID } }),
                this.client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
            ])

            const sessionInfo = sessionInfoResponse.data
            // Handle the response format - it should be { data: Array<{info, parts}> } or just the array
            const messages = messagesResponse.data || messagesResponse

            // If there are no messages or very few, skip analysis
            if (!messages || messages.length < 3) {
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

                            // Track the output content for size calculation
                            if (part.state?.status === "completed" && part.state.output) {
                                toolOutputs.set(normalizedId, part.state.output)
                            }

                            // Check if this is a batch tool by looking at the tool name
                            if (part.tool === "batch") {
                                currentBatchId = normalizedId
                                batchToolChildren.set(normalizedId, [])
                            }
                            // If we're inside a batch and this is a prt_ (parallel) tool call, it's a child
                            else if (currentBatchId && normalizedId.startsWith('prt_')) {
                                batchToolChildren.get(currentBatchId)!.push(normalizedId)
                            }
                            // If we hit a non-batch, non-prt_ tool, we're out of the batch
                            else if (currentBatchId && !normalizedId.startsWith('prt_')) {
                                currentBatchId = null
                            }
                        }
                    }
                }
            }

            // Get already pruned IDs to filter them out
            const alreadyPrunedIds = this.prunedIdsState.get(sessionID) ?? []
            const unprunedToolCallIds = toolCallIds.filter(id => !alreadyPrunedIds.includes(id))

            // If there are no unpruned tool calls, skip analysis
            if (unprunedToolCallIds.length === 0) {
                return
            }

            // ============================================================
            // PHASE 1: DUPLICATE DETECTION (runs for both modes)
            // ============================================================
            const dedupeResult = detectDuplicates(toolMetadata, unprunedToolCallIds, this.protectedTools)
            const deduplicatedIds = dedupeResult.duplicateIds
            const deduplicationDetails = dedupeResult.deduplicationDetails

            // Calculate candidates available for pruning (excludes protected tools)
            const candidateCount = unprunedToolCallIds.filter(id => {
                const metadata = toolMetadata.get(id)
                return !metadata || !this.protectedTools.includes(metadata.tool)
            }).length

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

                // Run LLM analysis only if there are prunable tools
                if (prunableToolCallIds.length > 0) {
                    // Select appropriate model with intelligent fallback
                    const cachedModelInfo = this.modelCache.get(sessionID)
                    const sessionModelInfo = extractModelFromSession(sessionInfo, this.logger)
                    const currentModelInfo = cachedModelInfo || sessionModelInfo

                    const modelSelection = await selectModel(currentModelInfo, this.logger, this.configModel, this.workingDirectory)

                    this.logger.info("janitor", `Model: ${modelSelection.modelInfo.providerID}/${modelSelection.modelInfo.modelID}`, {
                        source: modelSelection.source
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
                        } catch (toastError: any) {
                            // Don't fail the whole operation if toast fails
                        }
                    }

                    // Lazy import - only load the 2.8MB ai package when actually needed
                    const { generateObject } = await import('ai')

                    // Replace already-pruned tool outputs to save tokens in janitor context
                    const allPrunedSoFar = [...alreadyPrunedIds, ...deduplicatedIds]
                    const sanitizedMessages = this.replacePrunedToolOutputs(messages, allPrunedSoFar)

                    // Build the prompt for analysis
                    const analysisPrompt = buildAnalysisPrompt(prunableToolCallIds, sanitizedMessages, this.protectedTools, allPrunedSoFar, protectedToolCallIds)

                    // Save janitor shadow context directly (auth providers may bypass globalThis.fetch)
                    await this.logger.saveWrappedContext(
                        "janitor-shadow",
                        [{ role: "user", content: analysisPrompt }],
                        {
                            sessionID,
                            modelProvider: modelSelection.modelInfo.providerID,
                            modelID: modelSelection.modelInfo.modelID,
                            candidateToolCount: prunableToolCallIds.length,
                            alreadyPrunedCount: allPrunedSoFar.length,
                            protectedToolCount: protectedToolCallIds.length
                        }
                    )

                    // Analyze which tool calls are obsolete
                    const result = await generateObject({
                        model: modelSelection.model,
                        schema: z.object({
                            pruned_tool_call_ids: z.array(z.string()),
                            reasoning: z.string(),
                        }),
                        prompt: analysisPrompt
                    })

                    // Filter LLM results to only include IDs that were actually candidates
                    // (LLM sometimes returns duplicate IDs that were already filtered out)
                    const rawLlmPrunedIds = result.object.pruned_tool_call_ids
                    llmPrunedIds = rawLlmPrunedIds.filter(id =>
                        prunableToolCallIds.includes(id.toLowerCase())
                    )

                    if (llmPrunedIds.length > 0) {
                        const reasoning = result.object.reasoning.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
                        this.logger.info("janitor", `LLM reasoning: ${reasoning.substring(0, 200)}${reasoning.length > 200 ? '...' : ''}`)
                    }
                }
            }

            // ============================================================
            // PHASE 3: COMBINE & EXPAND
            // ============================================================
            const newlyPrunedIds = [...deduplicatedIds, ...llmPrunedIds]

            if (newlyPrunedIds.length === 0) {
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
                    children.forEach(childId => expandedPrunedIds.add(childId))
                }
            }

            // Calculate which IDs are actually NEW (not already pruned)
            const finalNewlyPrunedIds = Array.from(expandedPrunedIds).filter(id => !alreadyPrunedIds.includes(id))

            // finalPrunedIds includes everything (new + already pruned) for logging
            const finalPrunedIds = Array.from(expandedPrunedIds)

            // ============================================================
            // PHASE 4: NOTIFICATION
            // ============================================================
            // Calculate token savings once (used by both notification and log)
            const tokensSaved = await this.calculateTokensSaved(finalNewlyPrunedIds, toolOutputs)

            // Accumulate session stats (for showing cumulative totals in UI)
            const currentStats = this.statsState.get(sessionID) ?? { totalToolsPruned: 0, totalTokensSaved: 0 }
            const sessionStats: SessionStats = {
                totalToolsPruned: currentStats.totalToolsPruned + finalNewlyPrunedIds.length,
                totalTokensSaved: currentStats.totalTokensSaved + tokensSaved
            }
            this.statsState.set(sessionID, sessionStats)

            if (this.pruningMode === "auto") {
                await this.sendAutoModeNotification(
                    sessionID,
                    deduplicatedIds,
                    deduplicationDetails,
                    tokensSaved,
                    sessionStats
                )
            } else {
                await this.sendSmartModeNotification(
                    sessionID,
                    deduplicatedIds,
                    deduplicationDetails,
                    llmPrunedIds,
                    toolMetadata,
                    tokensSaved,
                    sessionStats
                )
            }

            // ============================================================
            // PHASE 5: STATE UPDATE
            // ============================================================
            // Merge newly pruned IDs with existing ones (using expanded IDs)
            const allPrunedIds = [...new Set([...alreadyPrunedIds, ...finalPrunedIds])]
            this.prunedIdsState.set(sessionID, allPrunedIds)

            // Log final summary
            // Format: "Pruned 5/5 tools (~4.2K tokens), 0 kept" or with breakdown if both duplicate and llm
            const prunedCount = finalNewlyPrunedIds.length
            const keptCount = candidateCount - prunedCount
            const hasBoth = deduplicatedIds.length > 0 && llmPrunedIds.length > 0
            const breakdown = hasBoth ? ` (${deduplicatedIds.length} duplicate, ${llmPrunedIds.length} llm)` : ""
            this.logger.info("janitor", `Pruned ${prunedCount}/${candidateCount} tools${breakdown}, ${keptCount} kept (~${formatTokenCount(tokensSaved)} tokens)`)

        } catch (error: any) {
            this.logger.error("janitor", "Analysis failed", {
                error: error.message
            })
            // Don't throw - this is a fire-and-forget background process
            // Silently fail and try again on next idle event
        }
    }

    /**
     * Helper function to shorten paths for display
     */
    private shortenPath(input: string): string {
        // Handle compound strings like: "pattern" in /absolute/path
        // Extract and shorten just the path portion
        const inPathMatch = input.match(/^(.+) in (.+)$/)
        if (inPathMatch) {
            const prefix = inPathMatch[1]
            const pathPart = inPathMatch[2]
            const shortenedPath = this.shortenSinglePath(pathPart)
            return `${prefix} in ${shortenedPath}`
        }

        return this.shortenSinglePath(input)
    }

    /**
     * Shorten a single path string
     */
    private shortenSinglePath(path: string): string {
        const homeDir = require('os').homedir()

        // Strip working directory FIRST (before ~ replacement) for cleaner relative paths
        if (this.workingDirectory) {
            if (path.startsWith(this.workingDirectory + '/')) {
                return path.slice(this.workingDirectory.length + 1)
            }
            // Exact match (the directory itself)
            if (path === this.workingDirectory) {
                return '.'
            }
        }

        // Replace home directory with ~
        if (path.startsWith(homeDir)) {
            path = '~' + path.slice(homeDir.length)
        }

        // Shorten node_modules paths: show package + file only
        const nodeModulesMatch = path.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)\/(.*)/)
        if (nodeModulesMatch) {
            return `${nodeModulesMatch[1]}/${nodeModulesMatch[2]}`
        }

        // Try matching against ~ version of working directory (for paths already with ~)
        if (this.workingDirectory) {
            const workingDirWithTilde = this.workingDirectory.startsWith(homeDir)
                ? '~' + this.workingDirectory.slice(homeDir.length)
                : null

            if (workingDirWithTilde && path.startsWith(workingDirWithTilde + '/')) {
                return path.slice(workingDirWithTilde.length + 1)
            }
            if (workingDirWithTilde && path === workingDirWithTilde) {
                return '.'
            }
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
            const tokenCounts = await estimateTokensBatch(outputsToTokenize)
            return tokenCounts.reduce((sum, count) => sum + count, 0)
        }

        return 0
    }

    /**
     * Build a summary of tools by grouping them
     * Uses shared extractParameterKey logic for consistent parameter extraction
     * 
     * Note: prunedIds may be in original case (from LLM) but toolMetadata uses lowercase keys
     */
    private buildToolsSummary(prunedIds: string[], toolMetadata: Map<string, { tool: string, parameters?: any }>): Map<string, string[]> {
        const toolsSummary = new Map<string, string[]>()

        // Helper function to truncate long strings
        const truncate = (str: string, maxLen: number = 60): string => {
            if (str.length <= maxLen) return str
            return str.slice(0, maxLen - 3) + '...'
        }

        for (const prunedId of prunedIds) {
            // Normalize ID to lowercase for lookup (toolMetadata uses lowercase keys)
            const normalizedId = prunedId.toLowerCase()
            const metadata = toolMetadata.get(normalizedId)
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
                } else {
                    // For tools with no extractable parameter key, add a placeholder
                    // This ensures the tool still shows up in the summary
                    toolsSummary.get(toolName)!.push('(default)')
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
        tokensSaved: number,
        sessionStats: SessionStats
    ) {
        if (totalPruned === 0) return

        const tokensFormatted = formatTokenCount(tokensSaved)
        const toolText = totalPruned === 1 ? 'tool' : 'tools'

        let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${totalPruned} ${toolText} pruned)`

        // Add session totals if there's been more than one pruning run
        if (sessionStats.totalToolsPruned > totalPruned) {
            message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
        }

        await this.sendIgnoredMessage(sessionID, message)
    }

    /**
     * Auto mode notification - shows only deduplication results
     */
    private async sendAutoModeNotification(
        sessionID: string,
        deduplicatedIds: string[],
        deduplicationDetails: Map<string, any>,
        tokensSaved: number,
        sessionStats: SessionStats
    ) {
        if (deduplicatedIds.length === 0) return

        // Check if notifications are disabled
        if (this.pruningSummary === 'off') return

        // Send minimal notification if configured
        if (this.pruningSummary === 'minimal') {
            await this.sendMinimalNotification(sessionID, deduplicatedIds.length, tokensSaved, sessionStats)
            return
        }

        // Otherwise send detailed notification
        const tokensFormatted = formatTokenCount(tokensSaved)

        const toolText = deduplicatedIds.length === 1 ? 'tool' : 'tools'
        let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${deduplicatedIds.length} duplicate ${toolText} removed)`

        // Add session totals if there's been more than one pruning run
        if (sessionStats.totalToolsPruned > deduplicatedIds.length) {
            message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
        }
        message += '\n'

        // Group by tool type
        const grouped = new Map<string, Array<{ count: number, key: string }>>()

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
        tokensSaved: number,
        sessionStats: SessionStats
    ) {
        const totalPruned = deduplicatedIds.length + llmPrunedIds.length
        if (totalPruned === 0) return

        // Check if notifications are disabled
        if (this.pruningSummary === 'off') return

        // Send minimal notification if configured
        if (this.pruningSummary === 'minimal') {
            await this.sendMinimalNotification(sessionID, totalPruned, tokensSaved, sessionStats)
            return
        }

        // Otherwise send detailed notification
        const tokensFormatted = formatTokenCount(tokensSaved)

        let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${totalPruned} tool${totalPruned > 1 ? 's' : ''} pruned)`

        // Add session totals if there's been more than one pruning run
        if (sessionStats.totalToolsPruned > totalPruned) {
            message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
        }
        message += '\n'

        // Section 1: Deduplicated tools
        if (deduplicatedIds.length > 0 && deduplicationDetails) {
            message += `\n📦 Duplicates removed (${deduplicatedIds.length}):\n`

            // Group by tool type
            const grouped = new Map<string, Array<{ count: number, key: string }>>()

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
                }
            }

            // Handle any tools that weren't found in metadata (edge case)
            const foundToolNames = new Set(toolsSummary.keys())
            const missingTools = llmPrunedIds.filter(id => {
                const normalizedId = id.toLowerCase()
                const metadata = toolMetadata.get(normalizedId)
                return !metadata || !foundToolNames.has(metadata.tool)
            })

            if (missingTools.length > 0) {
                message += `  (${missingTools.length} tool${missingTools.length > 1 ? 's' : ''} with unknown metadata)\n`
            }
        }

        await this.sendIgnoredMessage(sessionID, message.trim())
    }
}
