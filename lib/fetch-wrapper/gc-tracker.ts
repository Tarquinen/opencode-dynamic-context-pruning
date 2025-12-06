import type { PluginState } from "../state"
import type { Logger } from "../logger"

export function accumulateGCStats(
    state: PluginState,
    sessionId: string,
    prunedIds: string[],
    body: any,
    logger: Logger
): void {
    if (prunedIds.length === 0) return

    // Filter out IDs that have already been counted
    const newIds = prunedIds.filter(id => !state.gcCountedIds.has(id.toLowerCase()))
    if (newIds.length === 0) return

    const toolOutputs = extractToolOutputsFromBody(body, newIds)
    const tokensCollected = estimateTokensFromOutputs(toolOutputs)

    const existing = state.gcPending.get(sessionId) ?? { tokensCollected: 0, toolsGCd: 0 }

    state.gcPending.set(sessionId, {
        tokensCollected: existing.tokensCollected + tokensCollected,
        toolsGCd: existing.toolsGCd + newIds.length
    })

    // Mark these IDs as counted
    for (const id of newIds) {
        state.gcCountedIds.add(id.toLowerCase())
    }

    logger.debug("gc-tracker", "Accumulated GC stats (outputs)", {
        sessionId: sessionId.substring(0, 8),
        outputsDeduped: newIds.length,
        tokensThisCycle: tokensCollected,
        pendingTotal: state.gcPending.get(sessionId)
    })
}

/**
 * Accumulate GC stats for pruned tool inputs.
 * Uses state.toolParameters (from OpenCode API) instead of parsing LLM request body.
 */
export function accumulateGCInputStats(
    state: PluginState,
    sessionId: string,
    prunedIds: string[],
    logger: Logger
): void {
    if (prunedIds.length === 0) return

    // Filter out IDs that have already been counted
    const newIds = prunedIds.filter(id => !state.gcCountedIds.has(id.toLowerCase()))
    if (newIds.length === 0) return

    // Get input sizes from state.toolParameters (populated from OpenCode API)
    let totalChars = 0
    for (const id of newIds) {
        const entry = state.toolParameters.get(id.toLowerCase())
        if (entry?.parameters) {
            const paramStr = typeof entry.parameters === 'string'
                ? entry.parameters
                : JSON.stringify(entry.parameters)
            totalChars += paramStr.length
        }
    }
    const tokensCollected = Math.round(totalChars / 4)

    const existing = state.gcPending.get(sessionId) ?? { tokensCollected: 0, toolsGCd: 0 }

    state.gcPending.set(sessionId, {
        tokensCollected: existing.tokensCollected + tokensCollected,
        toolsGCd: existing.toolsGCd + newIds.length
    })

    // Mark these IDs as counted
    for (const id of newIds) {
        state.gcCountedIds.add(id.toLowerCase())
    }

    logger.debug("gc-tracker", "Accumulated GC stats (inputs)", {
        sessionId: sessionId.substring(0, 8),
        inputsPruned: newIds.length,
        tokensThisCycle: tokensCollected,
        pendingTotal: state.gcPending.get(sessionId)
    })
}

function extractToolOutputsFromBody(body: any, prunedIds: string[]): string[] {
    const outputs: string[] = []
    const prunedIdSet = new Set(prunedIds.map(id => id.toLowerCase()))

    // OpenAI Chat format
    if (body.messages && Array.isArray(body.messages)) {
        for (const m of body.messages) {
            if (m.role === 'tool' && m.tool_call_id && prunedIdSet.has(m.tool_call_id.toLowerCase())) {
                if (typeof m.content === 'string') {
                    outputs.push(m.content)
                }
            }
            // Anthropic format
            if (m.role === 'user' && Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (part.type === 'tool_result' && part.tool_use_id && prunedIdSet.has(part.tool_use_id.toLowerCase())) {
                        if (typeof part.content === 'string') {
                            outputs.push(part.content)
                        }
                    }
                }
            }
        }
    }

    // OpenAI Responses format
    if (body.input && Array.isArray(body.input)) {
        for (const item of body.input) {
            if (item.type === 'function_call_output' && item.call_id && prunedIdSet.has(item.call_id.toLowerCase())) {
                if (typeof item.output === 'string') {
                    outputs.push(item.output)
                }
            }
        }
    }

    return outputs
}

// Character-based approximation (chars / 4) to avoid async tokenizer in fetch path
function estimateTokensFromOutputs(outputs: string[]): number {
    let totalChars = 0
    for (const output of outputs) {
        totalChars += output.length
    }
    return Math.round(totalChars / 4)
}
