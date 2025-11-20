import { generateObject } from "ai"
import { createShadowModel } from "./factory"
import { z } from "zod"
import type { Logger } from "./logger"
import type { StateManager } from "./state"
import { buildAnalysisPrompt } from "./prompt"

export class Janitor {
    constructor(
        private client: any,
        private stateManager: StateManager,
        private logger: Logger,
        private toolParametersCache: Map<string, any>
    ) { }

    async run(sessionID: string) {
        this.logger.info("janitor", "Starting analysis", { sessionID })

        try {
            // Fetch session history from OpenCode API
            this.logger.debug("janitor", "Fetching session messages", { sessionID })
            const response = await this.client.session.messages({
                path: { id: sessionID },
                query: { limit: 100 }
            })

            // Handle the response format - it should be { data: Array<{info, parts}> } or just the array
            const messages = response.data || response

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
                            toolCallIds.push(part.callID)

                            // Try to get parameters from cache first, fall back to part.parameters
                            const cachedData = this.toolParametersCache.get(part.callID)
                            const parameters = cachedData?.parameters || part.parameters
                            
                            // Track tool metadata (name and parameters)
                            toolMetadata.set(part.callID, {
                                tool: part.tool,
                                parameters: parameters
                            })
                            
                            // Debug: log what we're storing
                            if (part.callID.startsWith('prt_') || part.tool === "read" || part.tool === "list") {
                                this.logger.debug("janitor", "Storing tool metadata", {
                                    sessionID,
                                    callID: part.callID,
                                    tool: part.tool,
                                    hasParameters: !!parameters,
                                    hasCached: !!cachedData,
                                    parameters: parameters
                                })
                            }

                            // Track the output content for size calculation
                            if (part.state?.status === "completed" && part.state.output) {
                                toolOutputs.set(part.callID, part.state.output)
                            }

                            // Check if this is a batch tool by looking at the tool name
                            if (part.tool === "batch") {
                                const batchId = part.callID
                                currentBatchId = batchId
                                batchToolChildren.set(batchId, [])
                                this.logger.debug("janitor", "Found batch tool", {
                                    sessionID,
                                    batchID: currentBatchId
                                })
                            }
                            // If we're inside a batch and this is a prt_ (parallel) tool call, it's a child
                            else if (currentBatchId && part.callID.startsWith('prt_')) {
                                const children = batchToolChildren.get(currentBatchId)!
                                children.push(part.callID)
                                this.logger.debug("janitor", "Added child to batch tool", {
                                    sessionID,
                                    batchID: currentBatchId,
                                    childID: part.callID,
                                    totalChildren: children.length
                                })
                            }
                            // If we hit a non-batch, non-prt_ tool, we're out of the batch
                            else if (currentBatchId && !part.callID.startsWith('prt_')) {
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
                unprunedCount: unprunedToolCallIds.length
            })

            // If there are no unpruned tool calls, skip analysis
            if (unprunedToolCallIds.length === 0) {
                this.logger.debug("janitor", "No unpruned tool calls found, skipping analysis", { sessionID })
                return
            }

            // Use big-pickle model - no auth needed!
            const model = createShadowModel()

            this.logger.debug("janitor", "Starting shadow inference", { sessionID })

            // Analyze which tool calls are obsolete
            const result = await generateObject({
                model,
                mode: "json", // Use JSON mode instead of native structured outputs
                schema: z.object({
                    pruned_tool_call_ids: z.array(z.string()),
                    reasoning: z.string(),
                }),
                prompt: buildAnalysisPrompt(unprunedToolCallIds, messages)
            })

            // Expand batch tool IDs to include their children
            const expandedPrunedIds = new Set<string>()
            for (const prunedId of result.object.pruned_tool_call_ids) {
                expandedPrunedIds.add(prunedId)

                // If this is a batch tool, add all its children
                const children = batchToolChildren.get(prunedId)
                if (children) {
                    this.logger.debug("janitor", "Expanding batch tool to include children", {
                        sessionID,
                        batchID: prunedId,
                        childCount: children.length,
                        childIDs: children
                    })
                    children.forEach(childId => expandedPrunedIds.add(childId))
                }
            }

            const finalPrunedIds = Array.from(expandedPrunedIds)

            this.logger.info("janitor", "Analysis complete", {
                sessionID,
                prunedCount: finalPrunedIds.length,
                originalPrunedCount: result.object.pruned_tool_call_ids.length,
                prunedIds: finalPrunedIds,
                reasoning: result.object.reasoning
            })

            // Calculate approximate size saved from newly pruned tool outputs (using expanded IDs)
            let totalCharsSaved = 0
            for (const prunedId of finalPrunedIds) {
                const output = toolOutputs.get(prunedId)
                if (output) {
                    totalCharsSaved += output.length
                }
            }

            // Rough token estimate (1 token ≈ 4 characters for English text)
            const estimatedTokensSaved = Math.round(totalCharsSaved / 4)

            // Merge newly pruned IDs with existing ones (using expanded IDs)
            const allPrunedIds = [...new Set([...alreadyPrunedIds, ...finalPrunedIds])]
            await this.stateManager.set(sessionID, allPrunedIds)
            this.logger.debug("janitor", "Updated state manager", {
                sessionID,
                totalPrunedCount: allPrunedIds.length,
                newlyPrunedCount: finalPrunedIds.length
            })

            // Show toast notification if we pruned anything
            if (finalPrunedIds.length > 0) {
                try {
                    // Helper function to shorten paths for display
                    const shortenPath = (path: string): string => {
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

                    // Helper function to truncate long strings
                    const truncate = (str: string, maxLen: number = 60): string => {
                        if (str.length <= maxLen) return str
                        return str.slice(0, maxLen - 3) + '...'
                    }

                    // Build a summary of pruned tools by grouping them
                    const toolsSummary = new Map<string, string[]>() // tool name -> [parameters]

                    for (const prunedId of finalPrunedIds) {
                        const metadata = toolMetadata.get(prunedId)
                        if (metadata) {
                            const toolName = metadata.tool
                            if (!toolsSummary.has(toolName)) {
                                toolsSummary.set(toolName, [])
                            }

                            this.logger.debug("janitor", "Processing pruned tool metadata", {
                                sessionID,
                                prunedId,
                                toolName,
                                parameters: metadata.parameters
                            })

                            // Extract meaningful parameter info based on tool type
                            let paramInfo = ""
                            if (metadata.parameters) {
                                // For read tool, show filePath
                                if (toolName === "read" && metadata.parameters.filePath) {
                                    paramInfo = truncate(shortenPath(metadata.parameters.filePath), 50)
                                }
                                // For list tool, show path
                                else if (toolName === "list" && metadata.parameters.path) {
                                    paramInfo = truncate(shortenPath(metadata.parameters.path), 50)
                                }
                                // For bash/command tools, prefer description over command
                                else if (toolName === "bash") {
                                    if (metadata.parameters.description) {
                                        paramInfo = truncate(metadata.parameters.description, 50)
                                    } else if (metadata.parameters.command) {
                                        paramInfo = truncate(metadata.parameters.command, 50)
                                    }
                                }
                                // For other tools, show the first relevant parameter
                                else if (metadata.parameters.path) {
                                    paramInfo = truncate(shortenPath(metadata.parameters.path), 50)
                                }
                                else if (metadata.parameters.pattern) {
                                    paramInfo = truncate(metadata.parameters.pattern, 50)
                                }
                                else if (metadata.parameters.command) {
                                    paramInfo = truncate(metadata.parameters.command, 50)
                                }
                            }

                            if (paramInfo) {
                                toolsSummary.get(toolName)!.push(paramInfo)
                            }
                        } else {
                            this.logger.warn("janitor", "No metadata found for pruned tool", {
                                sessionID,
                                prunedId
                            })
                        }
                    }

                    // Format the message with tool details
                    let message = `Pruned ${finalPrunedIds.length} tool output${finalPrunedIds.length > 1 ? 's' : ''} from context (~${estimatedTokensSaved.toLocaleString()} tokens saved)\n`
                    
                    for (const [toolName, params] of toolsSummary.entries()) {
                        if (params.length > 0) {
                            message += `\n${toolName} (${params.length}):\n`
                            for (const param of params) {
                                message += `  ${param}\n`
                            }
                        } else {
                            // For tools with no specific params (like batch), just show the tool name and count
                            const count = finalPrunedIds.filter(id => {
                                const m = toolMetadata.get(id)
                                return m && m.tool === toolName
                            }).length
                            if (count > 0) {
                                message += `\n${toolName} (${count})\n`
                            }
                        }
                    }

                    await this.client.tui.showToast({
                        body: {
                            title: "Context Pruned",
                            message: message.trim(),
                            variant: "success",
                            duration: 8000 // Longer duration since we're showing more info
                        }
                    })

                    this.logger.info("janitor", "Toast notification shown", {
                        sessionID,
                        prunedCount: finalPrunedIds.length,
                        estimatedTokensSaved,
                        totalCharsSaved,
                        toolsSummary: Array.from(toolsSummary.entries())
                    })
                } catch (toastError: any) {
                    this.logger.error("janitor", "Failed to show toast notification", {
                        sessionID,
                        error: toastError.message
                    })
                    // Don't fail the whole pruning operation if toast fails
                }
            }

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
}
