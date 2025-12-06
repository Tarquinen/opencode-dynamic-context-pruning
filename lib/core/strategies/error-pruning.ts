import { extractParameterKey } from "../../ui/display-utils"
import type { PruningStrategy, StrategyResult, ToolMetadata } from "./types"

/**
 * Minimum number of recent tool calls to protect from error pruning.
 * Tools older than this threshold will have their inputs pruned if they errored.
 */
const MIN_AGE_THRESHOLD = 5

/**
 * Error pruning strategy - prunes tool inputs (arguments) for tools that
 * resulted in an error, provided they are older than MIN_AGE_THRESHOLD.
 * 
 * This helps clean up failed attempts (like bad edits, file not found, etc.)
 * while keeping recent errors visible for the model to learn from.
 */
export const errorPruningStrategy: PruningStrategy = {
    name: "error-pruning",

    detect(
        toolMetadata: Map<string, ToolMetadata>,
        unprunedIds: string[],
        protectedTools: string[]
    ): StrategyResult {
        const prunedIds: string[] = []
        const details = new Map()

        // Don't prune the last N tool calls - model may still be iterating
        if (unprunedIds.length <= MIN_AGE_THRESHOLD) {
            return { prunedIds, details }
        }

        const pruneableIds = unprunedIds.slice(0, -MIN_AGE_THRESHOLD)
        const protectedToolsLower = protectedTools.map(t => t.toLowerCase())

        for (const id of pruneableIds) {
            const meta = toolMetadata.get(id)
            if (!meta) continue

            // Skip protected tools
            if (protectedToolsLower.includes(meta.tool.toLowerCase())) continue

            // Check if this tool errored
            if (meta.status === "error") {
                prunedIds.push(id)
                details.set(id, {
                    toolName: meta.tool,
                    parameterKey: extractParameterKey(meta),
                    reason: `error: ${meta.error || "unknown error"}`
                })
            }
        }

        return { prunedIds, details }
    }
}
