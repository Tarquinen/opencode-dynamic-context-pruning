/**
 * Model context limit inference utilities
 */

import { MODEL_CONTEXT_PATTERNS, DEFAULT_CONTEXT_LIMIT, EXTENDED_CONTEXT_LIMIT } from "./constants"

/**
 * Infer context limit from model ID pattern
 * Returns extended context limit for Claude models if env vars are set
 */
export function inferContextLimit(modelID: string): number {
    // Check for Claude models with extended context
    if (/claude-(opus|sonnet|haiku)/i.test(modelID)) {
        return EXTENDED_CONTEXT_LIMIT
    }

    // Check other model patterns
    for (const { pattern, limit } of MODEL_CONTEXT_PATTERNS) {
        if (pattern.test(modelID)) {
            return limit
        }
    }

    return DEFAULT_CONTEXT_LIMIT
}

/**
 * Calculate token usage ratio
 */
export function calculateUsageRatio(
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    contextLimit: number
): number {
    const totalUsed = inputTokens + cacheReadTokens + outputTokens
    return totalUsed / contextLimit
}
