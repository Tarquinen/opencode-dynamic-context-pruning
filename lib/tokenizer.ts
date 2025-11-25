/**
 * Token counting utilities using gpt-tokenizer
 * 
 * Uses gpt-tokenizer to provide token counts for text content.
 * Works with any LLM provider - provides accurate counts for OpenAI models
 * and reasonable approximations for other providers.
 * 
 * NOTE: gpt-tokenizer is lazily imported to avoid loading the 53MB package
 * during plugin initialization. The package is only loaded when tokenization
 * is actually needed.
 */

/**
 * Batch estimates tokens for multiple text samples
 * 
 * @param texts - Array of text strings to tokenize
 * @returns Array of token counts
 */
export async function estimateTokensBatch(texts: string[]): Promise<number[]> {
    try {
        // Lazy import - only load the 53MB gpt-tokenizer package when actually needed
        const { encode } = await import('gpt-tokenizer')
        return texts.map(text => encode(text).length)
    } catch {
        // Fallback to character-based estimation if tokenizer fails
        return texts.map(text => Math.round(text.length / 4))
    }
}

/**
 * Formats token count for display (e.g., 1500 -> "1.5K", 50 -> "50")
 * 
 * @param tokens - Number of tokens
 * @returns Formatted string
 */
export function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace('.0K', 'K')
    }
    return tokens.toString()
}
