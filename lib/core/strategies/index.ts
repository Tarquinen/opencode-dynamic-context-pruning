/**
 * Strategy runner - executes all enabled pruning strategies and collects results.
 */

import type { PruningStrategy, StrategyResult, ToolMetadata } from "./types"
import { deduplicationStrategy } from "./deduplication"
import { errorPruningStrategy } from "./error-pruning"

export type { PruningStrategy, StrategyResult, ToolMetadata, StrategyDetail } from "./types"

/** All available strategies */
const ALL_STRATEGIES: PruningStrategy[] = [
    deduplicationStrategy,
    errorPruningStrategy,
    // Future strategies will be added here:
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
 * Run all GC strategies and collect pruned IDs.
 * All strategies in ALL_STRATEGIES are always enabled (garbage collection).
 * 
 * @param toolMetadata - Map of tool call ID to metadata
 * @param unprunedIds - Tool call IDs not yet pruned (chronological order)
 * @param protectedTools - Tool names that should never be pruned
 */
export function runStrategies(
    toolMetadata: Map<string, ToolMetadata>,
    unprunedIds: string[],
    protectedTools: string[]
): RunStrategiesResult {
    const byStrategy = new Map<string, StrategyResult>()
    const allPrunedIds = new Set<string>()

    // Track which IDs are still available for each strategy
    let remainingIds = unprunedIds

    for (const strategy of ALL_STRATEGIES) {
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
