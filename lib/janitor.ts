import { z } from "zod"
import type { Logger } from "./logger"
import type { PruningStrategy } from "./config"
import { buildAnalysisPrompt } from "./prompt"
import { selectModel, extractModelFromSession } from "./model-selector"
import { estimateTokensBatch, formatTokenCount } from "./tokenizer"
import { detectDuplicates } from "./deduplicator"
import { extractParameterKey } from "./display-utils"

export interface SessionStats {
    totalToolsPruned: number
    totalTokensSaved: number
}

export interface PruningResult {
    prunedCount: number
    tokensSaved: number
    deduplicatedIds: string[]
    llmPrunedIds: string[]
    deduplicationDetails: Map<string, any>
    toolMetadata: Map<string, { tool: string, parameters?: any }>
    sessionStats: SessionStats
}

export interface PruningOptions {
    reason?: string
    trigger: 'idle' | 'tool'
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
        private configModel?: string,
        private showModelErrorToasts: boolean = true,
        private strictModelSelection: boolean = false,
        private pruningSummary: "off" | "minimal" | "detailed" = "detailed",
        private workingDirectory?: string
    ) { }

    private async sendIgnoredMessage(sessionID: string, text: string) {
        try {
            await this.client.session.prompt({
                path: { id: sessionID },
                body: {
                    noReply: true,
                    parts: [{
                        type: 'text',
                        text: text,
                        ignored: true
                    }]
                }
            })
        } catch (error: any) {
            this.logger.error("janitor", "Failed to send notification", { error: error.message })
        }
    }

    async runOnIdle(sessionID: string, strategies: PruningStrategy[]): Promise<void> {
        await this.runWithStrategies(sessionID, strategies, { trigger: 'idle' })
    }

    async runForTool(
        sessionID: string,
        strategies: PruningStrategy[],
        reason?: string
    ): Promise<PruningResult | null> {
        return await this.runWithStrategies(sessionID, strategies, { trigger: 'tool', reason })
    }

    async runWithStrategies(
        sessionID: string,
        strategies: PruningStrategy[],
        options: PruningOptions
    ): Promise<PruningResult | null> {
        try {
            if (strategies.length === 0) {
                return null
            }

            const [sessionInfoResponse, messagesResponse] = await Promise.all([
                this.client.session.get({ path: { id: sessionID } }),
                this.client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
            ])

            const sessionInfo = sessionInfoResponse.data
            const messages = messagesResponse.data || messagesResponse

            if (!messages || messages.length < 3) {
                return null
            }

            const toolCallIds: string[] = []
            const toolOutputs = new Map<string, string>()
            const toolMetadata = new Map<string, { tool: string, parameters?: any }>()
            const batchToolChildren = new Map<string, string[]>()
            let currentBatchId: string | null = null

            for (const msg of messages) {
                if (msg.parts) {
                    for (const part of msg.parts) {
                        if (part.type === "tool" && part.callID) {
                            const normalizedId = part.callID.toLowerCase()
                            toolCallIds.push(normalizedId)

                            const cachedData = this.toolParametersCache.get(part.callID) || this.toolParametersCache.get(normalizedId)
                            const parameters = cachedData?.parameters ?? part.state?.input ?? part.parameters

                            toolMetadata.set(normalizedId, {
                                tool: part.tool,
                                parameters: parameters
                            })

                            if (part.state?.status === "completed" && part.state.output) {
                                toolOutputs.set(normalizedId, part.state.output)
                            }

                            if (part.tool === "batch") {
                                currentBatchId = normalizedId
                                batchToolChildren.set(normalizedId, [])
                            } else if (currentBatchId && normalizedId.startsWith('prt_')) {
                                batchToolChildren.get(currentBatchId)!.push(normalizedId)
                            } else if (currentBatchId && !normalizedId.startsWith('prt_')) {
                                currentBatchId = null
                            }
                        }
                    }
                }
            }

            const alreadyPrunedIds = this.prunedIdsState.get(sessionID) ?? []
            const unprunedToolCallIds = toolCallIds.filter(id => !alreadyPrunedIds.includes(id))

            if (unprunedToolCallIds.length === 0) {
                return null
            }

            // PHASE 1: DUPLICATE DETECTION
            let deduplicatedIds: string[] = []
            let deduplicationDetails = new Map<string, any>()

            if (strategies.includes('deduplication')) {
                const dedupeResult = detectDuplicates(toolMetadata, unprunedToolCallIds, this.protectedTools)
                deduplicatedIds = dedupeResult.duplicateIds
                deduplicationDetails = dedupeResult.deduplicationDetails
            }

            const candidateCount = unprunedToolCallIds.filter(id => {
                const metadata = toolMetadata.get(id)
                return !metadata || !this.protectedTools.includes(metadata.tool)
            }).length

            // PHASE 2: LLM ANALYSIS
            let llmPrunedIds: string[] = []

            if (strategies.includes('ai-analysis')) {
                const protectedToolCallIds: string[] = []
                const prunableToolCallIds = unprunedToolCallIds.filter(id => {
                    if (deduplicatedIds.includes(id)) return false

                    const metadata = toolMetadata.get(id)
                    if (metadata && this.protectedTools.includes(metadata.tool)) {
                        protectedToolCallIds.push(id)
                        return false
                    }

                    return true
                })

                if (prunableToolCallIds.length > 0) {
                    const cachedModelInfo = this.modelCache.get(sessionID)
                    const sessionModelInfo = extractModelFromSession(sessionInfo, this.logger)
                    const currentModelInfo = cachedModelInfo || sessionModelInfo

                    const modelSelection = await selectModel(currentModelInfo, this.logger, this.configModel, this.workingDirectory)

                    this.logger.info("janitor", `Model: ${modelSelection.modelInfo.providerID}/${modelSelection.modelInfo.modelID}`, {
                        source: modelSelection.source
                    })

                    if (modelSelection.failedModel && this.showModelErrorToasts) {
                        const skipAi = modelSelection.source === 'fallback' && this.strictModelSelection
                        try {
                            await this.client.tui.showToast({
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
                        }
                    }

                    if (modelSelection.source === 'fallback' && this.strictModelSelection) {
                        this.logger.info("janitor", "Skipping AI analysis (fallback model, strictModelSelection enabled)")
                    } else {
                        const { generateObject } = await import('ai')

                        const allPrunedSoFar = [...alreadyPrunedIds, ...deduplicatedIds]
                        const sanitizedMessages = this.replacePrunedToolOutputs(messages, allPrunedSoFar)

                        const analysisPrompt = buildAnalysisPrompt(
                            prunableToolCallIds,
                            sanitizedMessages,
                            allPrunedSoFar,
                            protectedToolCallIds,
                            options.reason
                        )

                        await this.logger.saveWrappedContext(
                            "janitor-shadow",
                            [{ role: "user", content: analysisPrompt }],
                            {
                                sessionID,
                                modelProvider: modelSelection.modelInfo.providerID,
                                modelID: modelSelection.modelInfo.modelID,
                                candidateToolCount: prunableToolCallIds.length,
                                alreadyPrunedCount: allPrunedSoFar.length,
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
                        llmPrunedIds = rawLlmPrunedIds.filter(id =>
                            prunableToolCallIds.includes(id.toLowerCase())
                        )

                        if (llmPrunedIds.length > 0) {
                            const reasoning = result.object.reasoning.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
                            this.logger.info("janitor", `LLM reasoning: ${reasoning.substring(0, 200)}${reasoning.length > 200 ? '...' : ''}`)
                        }
                    }
                }
            }

            // PHASE 3: COMBINE & EXPAND
            const newlyPrunedIds = [...deduplicatedIds, ...llmPrunedIds]

            if (newlyPrunedIds.length === 0) {
                return null
            }

            const expandBatchIds = (ids: string[]): string[] => {
                const expanded = new Set<string>()
                for (const id of ids) {
                    const normalizedId = id.toLowerCase()
                    expanded.add(normalizedId)
                    const children = batchToolChildren.get(normalizedId)
                    if (children) {
                        children.forEach(childId => expanded.add(childId))
                    }
                }
                return Array.from(expanded)
            }

            const expandedPrunedIds = new Set(expandBatchIds(newlyPrunedIds))
            const expandedLlmPrunedIds = expandBatchIds(llmPrunedIds)
            const finalNewlyPrunedIds = Array.from(expandedPrunedIds).filter(id => !alreadyPrunedIds.includes(id))
            const finalPrunedIds = Array.from(expandedPrunedIds)

            // PHASE 4: CALCULATE STATS & NOTIFICATION
            const tokensSaved = await this.calculateTokensSaved(finalNewlyPrunedIds, toolOutputs)

            const currentStats = this.statsState.get(sessionID) ?? { totalToolsPruned: 0, totalTokensSaved: 0 }
            const sessionStats: SessionStats = {
                totalToolsPruned: currentStats.totalToolsPruned + finalNewlyPrunedIds.length,
                totalTokensSaved: currentStats.totalTokensSaved + tokensSaved
            }
            this.statsState.set(sessionID, sessionStats)

            const hasLlmAnalysis = strategies.includes('ai-analysis')

            if (hasLlmAnalysis) {
                await this.sendSmartModeNotification(
                    sessionID,
                    deduplicatedIds,
                    deduplicationDetails,
                    expandedLlmPrunedIds,
                    toolMetadata,
                    tokensSaved,
                    sessionStats
                )
            } else {
                await this.sendAutoModeNotification(
                    sessionID,
                    deduplicatedIds,
                    deduplicationDetails,
                    tokensSaved,
                    sessionStats
                )
            }

            // PHASE 5: STATE UPDATE
            const allPrunedIds = [...new Set([...alreadyPrunedIds, ...finalPrunedIds])]
            this.prunedIdsState.set(sessionID, allPrunedIds)

            const prunedCount = finalNewlyPrunedIds.length
            const keptCount = candidateCount - prunedCount
            const hasBoth = deduplicatedIds.length > 0 && llmPrunedIds.length > 0
            const breakdown = hasBoth ? ` (${deduplicatedIds.length} duplicate, ${llmPrunedIds.length} llm)` : ""

            const logMeta: Record<string, any> = { trigger: options.trigger }
            if (options.reason) {
                logMeta.reason = options.reason
            }

            this.logger.info("janitor", `Pruned ${prunedCount}/${candidateCount} tools${breakdown}, ${keptCount} kept (~${formatTokenCount(tokensSaved)} tokens)`, logMeta)

            return {
                prunedCount: finalNewlyPrunedIds.length,
                tokensSaved,
                deduplicatedIds,
                llmPrunedIds: expandedLlmPrunedIds,
                deduplicationDetails,
                toolMetadata,
                sessionStats
            }

        } catch (error: any) {
            this.logger.error("janitor", "Analysis failed", {
                error: error.message,
                trigger: options.trigger
            })
            return null
        }
    }

    private shortenPath(input: string): string {
        const inPathMatch = input.match(/^(.+) in (.+)$/)
        if (inPathMatch) {
            const prefix = inPathMatch[1]
            const pathPart = inPathMatch[2]
            const shortenedPath = this.shortenSinglePath(pathPart)
            return `${prefix} in ${shortenedPath}`
        }

        return this.shortenSinglePath(input)
    }

    private shortenSinglePath(path: string): string {
        const homeDir = require('os').homedir()

        if (this.workingDirectory) {
            if (path.startsWith(this.workingDirectory + '/')) {
                return path.slice(this.workingDirectory.length + 1)
            }
            if (path === this.workingDirectory) {
                return '.'
            }
        }

        if (path.startsWith(homeDir)) {
            path = '~' + path.slice(homeDir.length)
        }

        const nodeModulesMatch = path.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)\/(.*)/)
        if (nodeModulesMatch) {
            return `${nodeModulesMatch[1]}/${nodeModulesMatch[2]}`
        }

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

    private async calculateTokensSaved(prunedIds: string[], toolOutputs: Map<string, string>): Promise<number> {
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

    private buildToolsSummary(prunedIds: string[], toolMetadata: Map<string, { tool: string, parameters?: any }>): Map<string, string[]> {
        const toolsSummary = new Map<string, string[]>()

        const truncate = (str: string, maxLen: number = 60): string => {
            if (str.length <= maxLen) return str
            return str.slice(0, maxLen - 3) + '...'
        }

        for (const prunedId of prunedIds) {
            const normalizedId = prunedId.toLowerCase()
            const metadata = toolMetadata.get(normalizedId)
            if (metadata) {
                const toolName = metadata.tool
                if (toolName === 'batch') continue
                if (!toolsSummary.has(toolName)) {
                    toolsSummary.set(toolName, [])
                }

                const paramKey = extractParameterKey(metadata)
                if (paramKey) {
                    const displayKey = truncate(this.shortenPath(paramKey), 80)
                    toolsSummary.get(toolName)!.push(displayKey)
                } else {
                    toolsSummary.get(toolName)!.push('(default)')
                }
            }
        }

        return toolsSummary
    }

    private groupDeduplicationDetails(
        deduplicationDetails: Map<string, any>
    ): Map<string, Array<{ count: number, key: string }>> {
        const grouped = new Map<string, Array<{ count: number, key: string }>>()

        for (const [_, details] of deduplicationDetails) {
            const { toolName, parameterKey, duplicateCount } = details
            if (toolName === 'batch') continue
            if (!grouped.has(toolName)) {
                grouped.set(toolName, [])
            }
            grouped.get(toolName)!.push({
                count: duplicateCount,
                key: this.shortenPath(parameterKey)
            })
        }

        return grouped
    }

    private formatDeduplicationLines(
        grouped: Map<string, Array<{ count: number, key: string }>>,
        indent: string = '  '
    ): string[] {
        const lines: string[] = []

        for (const [toolName, items] of grouped.entries()) {
            for (const item of items) {
                const removedCount = item.count - 1
                lines.push(`${indent}${toolName}: ${item.key} (${removedCount}× duplicate)`)
            }
        }

        return lines
    }

    private formatToolSummaryLines(
        toolsSummary: Map<string, string[]>,
        indent: string = '  '
    ): string[] {
        const lines: string[] = []

        for (const [toolName, params] of toolsSummary.entries()) {
            if (params.length === 1) {
                lines.push(`${indent}${toolName}: ${params[0]}`)
            } else if (params.length > 1) {
                lines.push(`${indent}${toolName} (${params.length}):`)
                for (const param of params) {
                    lines.push(`${indent}  ${param}`)
                }
            }
        }

        return lines
    }

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

        if (sessionStats.totalToolsPruned > totalPruned) {
            message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
        }

        await this.sendIgnoredMessage(sessionID, message)
    }

    private async sendAutoModeNotification(
        sessionID: string,
        deduplicatedIds: string[],
        deduplicationDetails: Map<string, any>,
        tokensSaved: number,
        sessionStats: SessionStats
    ) {
        if (deduplicatedIds.length === 0) return
        if (this.pruningSummary === 'off') return

        if (this.pruningSummary === 'minimal') {
            await this.sendMinimalNotification(sessionID, deduplicatedIds.length, tokensSaved, sessionStats)
            return
        }

        const tokensFormatted = formatTokenCount(tokensSaved)
        const toolText = deduplicatedIds.length === 1 ? 'tool' : 'tools'
        let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${deduplicatedIds.length} duplicate ${toolText} removed)`

        if (sessionStats.totalToolsPruned > deduplicatedIds.length) {
            message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
        }
        message += '\n'

        const grouped = this.groupDeduplicationDetails(deduplicationDetails)

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

    formatPruningResultForTool(result: PruningResult): string {
        const lines: string[] = []
        lines.push(`Context pruning complete. Pruned ${result.prunedCount} tool outputs.`)
        lines.push('')

        if (result.deduplicatedIds.length > 0 && result.deduplicationDetails.size > 0) {
            lines.push(`Duplicates removed (${result.deduplicatedIds.length}):`)
            const grouped = this.groupDeduplicationDetails(result.deduplicationDetails)
            lines.push(...this.formatDeduplicationLines(grouped))
            lines.push('')
        }

        if (result.llmPrunedIds.length > 0) {
            lines.push(`Semantically pruned (${result.llmPrunedIds.length}):`)
            const toolsSummary = this.buildToolsSummary(result.llmPrunedIds, result.toolMetadata)
            lines.push(...this.formatToolSummaryLines(toolsSummary))
        }

        return lines.join('\n').trim()
    }

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
        if (this.pruningSummary === 'off') return

        if (this.pruningSummary === 'minimal') {
            await this.sendMinimalNotification(sessionID, totalPruned, tokensSaved, sessionStats)
            return
        }

        const tokensFormatted = formatTokenCount(tokensSaved)

        let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${totalPruned} tool${totalPruned > 1 ? 's' : ''} pruned)`

        if (sessionStats.totalToolsPruned > totalPruned) {
            message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
        }
        message += '\n'

        if (deduplicatedIds.length > 0 && deduplicationDetails) {
            message += `\n📦 Duplicates removed (${deduplicatedIds.length}):\n`
            const grouped = this.groupDeduplicationDetails(deduplicationDetails)

            for (const [toolName, items] of grouped.entries()) {
                message += `  ${toolName}:\n`
                for (const item of items) {
                    const removedCount = item.count - 1
                    message += `    ${item.key} (${removedCount}× duplicate)\n`
                }
            }
        }

        if (llmPrunedIds.length > 0) {
            message += `\n🤖 LLM analysis (${llmPrunedIds.length}):\n`
            const toolsSummary = this.buildToolsSummary(llmPrunedIds, toolMetadata)

            for (const [toolName, params] of toolsSummary.entries()) {
                if (params.length > 0) {
                    message += `  ${toolName} (${params.length}):\n`
                    for (const param of params) {
                        message += `    ${param}\n`
                    }
                }
            }

            const foundToolNames = new Set(toolsSummary.keys())
            const missingTools = llmPrunedIds.filter(id => {
                const normalizedId = id.toLowerCase()
                const metadata = toolMetadata.get(normalizedId)
                if (metadata?.tool === 'batch') return false
                return !metadata || !foundToolNames.has(metadata.tool)
            })

            if (missingTools.length > 0) {
                message += `  (${missingTools.length} tool${missingTools.length > 1 ? 's' : ''} with unknown metadata)\n`
            }
        }

        await this.sendIgnoredMessage(sessionID, message.trim())
    }
}
