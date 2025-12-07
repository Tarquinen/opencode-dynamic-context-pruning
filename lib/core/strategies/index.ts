/**
 * Strategy runner - executes all enabled pruning strategies and collects results.
 */

import { deduplicationStrategy } from "./deduplication"
import type { ToolMetadata } from "../../fetch-wrapper/types"

export type { ToolMetadata }

/**
 * Common interface for rule-based pruning strategies.
 * Each strategy analyzes tool metadata and returns IDs that should be pruned.
 */

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

/** All available strategies */
const ALL_STRATEGIES: PruningStrategy[] = [
    deduplicationStrategy,
    // Future strategies will be added here:
    // errorPruningStrategy,
    // writeReadStrategy,
    // partialReadStrategy,
]

export interface RunStrategiesResult {
    /** All tool IDs that should be pruned (deduplicated) */
    prunedIds: string[]
    /** Results keyed by strategy name */
    byStrategy: Map<string, StrategyResult>
}

/**
 * Run all enabled strategies and collect pruned IDs.
 * 
 * @param toolMetadata - Map of tool call ID to metadata
 * @param unprunedIds - Tool call IDs not yet pruned (chronological order)
 * @param protectedTools - Tool names that should never be pruned
 * @param enabledStrategies - Strategy names to run (defaults to all)
 */
export function runStrategies(
    toolMetadata: Map<string, ToolMetadata>,
    unprunedIds: string[],
    protectedTools: string[],
    enabledStrategies?: string[]
): RunStrategiesResult {
    const byStrategy = new Map<string, StrategyResult>()
    const allPrunedIds = new Set<string>()

    // Filter to enabled strategies (or all if not specified)
    const strategies = enabledStrategies
        ? ALL_STRATEGIES.filter(s => enabledStrategies.includes(s.name))
        : ALL_STRATEGIES

    // Track which IDs are still available for each strategy
    let remainingIds = unprunedIds

    for (const strategy of strategies) {
        const result = strategy.detect(toolMetadata, remainingIds, protectedTools)

        if (result.prunedIds.length > 0) {
            byStrategy.set(strategy.name, result)

            // Add to overall pruned set
            for (const id of result.prunedIds) {
                allPrunedIds.add(id)
            }

            // Remove pruned IDs from remaining for next strategy
            const prunedSet = new Set(result.prunedIds.map(id => id.toLowerCase()))
            remainingIds = remainingIds.filter(id => !prunedSet.has(id.toLowerCase()))
        }
    }

    return {
        prunedIds: Array.from(allPrunedIds),
        byStrategy
    }
}
