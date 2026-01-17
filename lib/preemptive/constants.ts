/**
 * Constants for preemptive compaction feature
 */

// Default configuration values
export const DEFAULT_THRESHOLD = 0.85
export const DEFAULT_COOLDOWN_MS = 60000
export const MIN_TOKENS_FOR_COMPACTION = 50000
export const DEFAULT_PROTECTED_MESSAGES = 3
export const CHARS_PER_TOKEN = 4

// Message shown when tool output is truncated
export const TRUNCATION_MESSAGE =
    "[TOOL RESULT TRUNCATED - Context limit exceeded. Original output was too large and has been truncated. Re-run this tool if you need the full output.]"

// Model context limits for inference when not configured
export const MODEL_CONTEXT_PATTERNS: Array<{ pattern: RegExp; limit: number }> = [
    // Claude models (check for 1M context env vars)
    { pattern: /claude-(opus|sonnet|haiku)/i, limit: 200_000 },
    // GPT-5.x models (1M context)
    { pattern: /gpt-5/i, limit: 1_000_000 },
    // GPT-4 models
    { pattern: /gpt-4-turbo|gpt-4o/i, limit: 128_000 },
    { pattern: /gpt-4(?!o)/i, limit: 8_192 },
    // OpenAI reasoning models
    { pattern: /o1|o3/i, limit: 200_000 },
    // Gemini models
    { pattern: /gemini-3/i, limit: 2_000_000 },
    { pattern: /gemini-2\.5-pro/i, limit: 2_000_000 },
    { pattern: /gemini/i, limit: 1_000_000 },
]

// Fallback context limit when model is not recognized
export const DEFAULT_CONTEXT_LIMIT = 200_000

// Extended context for environments with 1M enabled
export const EXTENDED_CONTEXT_LIMIT =
    process.env.ANTHROPIC_1M_CONTEXT === "true" || process.env.VERTEX_ANTHROPIC_1M_CONTEXT === "true"
        ? 1_000_000
        : DEFAULT_CONTEXT_LIMIT
