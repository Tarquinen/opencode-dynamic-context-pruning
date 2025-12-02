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

    const toolOutputs = extractToolOutputsFromBody(body, prunedIds)
    const tokensCollected = estimateTokensFromOutputs(toolOutputs)

    const existing = state.gcPending.get(sessionId) ?? { tokensCollected: 0, toolsDeduped: 0 }
    
    state.gcPending.set(sessionId, {
        tokensCollected: existing.tokensCollected + tokensCollected,
        toolsDeduped: existing.toolsDeduped + prunedIds.length
    })

    logger.debug("gc-tracker", "Accumulated GC stats", {
        sessionId: sessionId.substring(0, 8),
        newlyDeduped: prunedIds.length,
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
