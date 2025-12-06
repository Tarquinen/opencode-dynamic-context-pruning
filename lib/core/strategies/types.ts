/**
 * Common interface for rule-based pruning strategies.
 * Each strategy analyzes tool metadata and returns IDs that should be pruned.
 */

export interface ToolMetadata {
    tool: string
    parameters?: any
    status?: "pending" | "running" | "completed" | "error"
    error?: string
}

export interface StrategyResult {
    /** Tool call IDs that should be pruned */
    prunedIds: string[]
    /** Optional details about what was pruned and why */
    details?: Map<string, StrategyDetail>
}

export interface StrategyDetail {
    toolName: string
    parameterKey: string
    reason: string
    /** Additional info specific to the strategy */
    [key: string]: any
}

export interface PruningStrategy {
    /** Unique identifier for this strategy */
    name: string

    /**
     * Analyze tool metadata and determine which tool calls should be pruned.
     * 
     * @param toolMetadata - Map of tool call ID to metadata (tool name + parameters)
     * @param unprunedIds - Tool call IDs that haven't been pruned yet (chronological order)
     * @param protectedTools - Tool names that should never be pruned
     * @returns IDs to prune and optional details
     */
    detect(
        toolMetadata: Map<string, ToolMetadata>,
        unprunedIds: string[],
        protectedTools: string[]
    ): StrategyResult
}
