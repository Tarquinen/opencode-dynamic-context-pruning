import { SessionState, WithParts } from "./state"
import { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "./logger"
import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
import { getLastUserMessage } from "./messages/query"

const anthropicGetTokenizer = (_anthropicTokenizer.getTokenizer ??
    (_anthropicTokenizer as any).default?.getTokenizer) as typeof _anthropicTokenizer.getTokenizer

// The package's countTokens() builds and frees a WASM tokenizer on every call (~70 ms each),
// while an encode() on a reused tokenizer costs a fraction of a millisecond (upstream #638/#639).
// Build it once and share it. Never free() the shared instance.
let anthropicTokenizer: ReturnType<typeof anthropicGetTokenizer> | undefined

function tokenizeExact(text: string): number {
    anthropicTokenizer ??= anthropicGetTokenizer()
    return anthropicTokenizer.encode(text.normalize("NFKC"), "all").length
}

// encode() runs synchronously on the host's event loop and its cost is super-linear on long
// runs without token boundaries: a single huge input could block OpenCode for seconds
// (upstream #659). Count exactly up to this many characters and extrapolate from samples above
// it, so one call can never block the host. Override with DCP_TOKEN_COUNT_MAX_EXACT_CHARS
// (0 samples every text; a huge value forces exact counting).
const DEFAULT_MAX_EXACT_CHARS = 16 * 1024
const SAMPLE_CHARS = 2048

function maxExactChars(): number {
    const raw = process.env.DCP_TOKEN_COUNT_MAX_EXACT_CHARS
    if (raw === undefined) return DEFAULT_MAX_EXACT_CHARS
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_EXACT_CHARS
    return Math.min(parsed, Number.MAX_SAFE_INTEGER)
}

// A long run of one repeated character has no token boundaries for the encoder, and its cost
// grows super-linearly: 10k characters can already block the host for hundreds of milliseconds
// (upstream #659). Treat such inputs as huge and sample them too. Up to DEGENERATE_RUN_SAFE_CHARS
// a repeated run is cheap enough to count exactly (measured ~20 ms at 4k characters), and the
// run scan is bounded by the exact-count limit with cheap charCodeAt comparisons.
const MAX_CHAR_RUN = 512
const DEGENERATE_RUN_SAFE_CHARS = 4 * 1024

function hasLongCharRun(text: string): boolean {
    let run = 1
    for (let i = 1; i < text.length; i++) {
        if (text.charCodeAt(i) === text.charCodeAt(i - 1)) {
            run++
            if (run >= MAX_CHAR_RUN) return true
        } else {
            run = 1
        }
    }
    return false
}

// The same summaries, system prompt and tool outputs are re-counted on every chat-messages
// transform (and again after tool-cache evictions), so memoize exact counts. Keys are capped by
// size and total bytes to keep the cache bounded; sampled counts are cheap and are not cached.
const CACHE_MAX_ENTRIES = 1024
const CACHE_MAX_CHARS = 4 * 1024 * 1024
const exactCountCache = new Map<string, number>()
let exactCountCacheChars = 0

function trimExactCountCache(): void {
    while (exactCountCache.size > CACHE_MAX_ENTRIES || exactCountCacheChars > CACHE_MAX_CHARS) {
        const oldest = exactCountCache.keys().next().value
        if (oldest === undefined) return
        exactCountCacheChars -= oldest.length
        exactCountCache.delete(oldest)
    }
}

/** Clears the shared tokenizer and the count cache. Test helper only. */
export function resetTokenCountingForTests(): void {
    anthropicTokenizer = undefined
    exactCountCache.clear()
    exactCountCacheChars = 0
}

function estimateTokensFromSamples(text: string): number {
    // Disjoint windows: head, middle and tail, each at most SAMPLE_CHARS and at least one third
    // of the input, so the sampled density is representative and the sampled area is known.
    const window = Math.min(SAMPLE_CHARS, Math.floor(text.length / 3))
    if (window < 16) return tokenizeExact(text)
    const middleStart = (text.length - window) >> 1
    const head = tokenizeExact(text.slice(0, window))
    const middle = tokenizeExact(text.slice(middleStart, middleStart + window))
    const tail = tokenizeExact(text.slice(-window))
    const perChar = (head + middle + tail) / (3 * window)
    return Math.max(1, Math.round(perChar * text.length))
}

export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }

        const assistantInfo = msg.info as AssistantMessage
        if ((assistantInfo.tokens?.output || 0) <= 0) {
            continue
        }

        if (
            state.lastCompaction > 0 &&
            (msg.info.time.created < state.lastCompaction ||
                (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
        ) {
            return 0
        }

        const input = assistantInfo.tokens?.input || 0
        const output = assistantInfo.tokens?.output || 0
        const reasoning = assistantInfo.tokens?.reasoning || 0
        const cacheRead = assistantInfo.tokens?.cache?.read || 0
        const cacheWrite = assistantInfo.tokens?.cache?.write || 0
        return input + output + reasoning + cacheRead + cacheWrite
    }

    return 0
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: undefined,
        }
    }
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
    const variant: string | undefined = userInfo.model.variant

    return { providerId, modelId, agent, variant }
}

export function countTokens(text: string): number {
    if (!text) return 0

    const cached = exactCountCache.get(text)
    if (cached !== undefined) {
        exactCountCache.delete(text)
        exactCountCache.set(text, cached)
        return cached
    }

    const limit = maxExactChars()
    const exact =
        text.length <= limit && (text.length <= DEGENERATE_RUN_SAFE_CHARS || !hasLongCharRun(text))

    let tokens: number
    try {
        tokens = exact ? tokenizeExact(text) : estimateTokensFromSamples(text)
    } catch {
        anthropicTokenizer = undefined
        return Math.round(text.length / 4)
    }

    if (exact) {
        exactCountCache.set(text, tokens)
        exactCountCacheChars += text.length
        trimExactCountCache()
    }

    if (process.env.DCP_TOKEN_DEBUG === "1") {
        process.stderr.write(
            `[dcp-token] chars=${text.length} tokens=${tokens} path=${exact ? "exact" : "sampled"}\n`,
        )
    }

    return tokens
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    let total = 0
    for (const text of texts) total += countTokens(text)
    return total
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

export function extractCompletedToolOutput(part: any): string | undefined {
    if (
        part?.type !== "tool" ||
        part.state?.status !== "completed" ||
        part.state?.output === undefined
    ) {
        return undefined
    }

    if (part.state?.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part?.type !== "tool") {
        return contents
    }

    if (part.state?.input !== undefined) {
        contents.push(stringifyToolContent(part.state.input))
    }

    const completedOutput = extractCompletedToolOutput(part)
    if (completedOutput !== undefined) {
        contents.push(completedOutput)
    } else if (part.state?.status === "error" && part.state?.error) {
        contents.push(stringifyToolContent(part.state.error))
    }

    return contents
}

export function countToolTokens(part: any): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

export function countMessageTextTokens(msg: WithParts): number {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countAllMessageTokens(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        } else {
            texts.push(...extractToolContent(part))
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}
