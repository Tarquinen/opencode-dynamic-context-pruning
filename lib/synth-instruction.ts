export interface ToolTracker {
    seenToolResultIds: Set<string>
    toolResultCount: number
    skipNextIdle: boolean
    getToolName?: (callId: string) => string | undefined
}

export function createToolTracker(): ToolTracker {
    return { seenToolResultIds: new Set(), toolResultCount: 0, skipNextIdle: false }
}

export function resetToolTrackerCount(tracker: ToolTracker, freq: number): void {
    const currentBucket = Math.floor(tracker.toolResultCount / freq)
    tracker.toolResultCount = currentBucket * freq
}

/** Adapter interface for format-specific message operations */
interface MessageFormatAdapter {
    countToolResults(messages: any[], tracker: ToolTracker): number
    appendNudge(messages: any[], nudgeText: string): void
}

/** Generic nudge injection - counts tool results and injects nudge every N results */
function injectNudgeCore(
    messages: any[],
    tracker: ToolTracker,
    nudgeText: string,
    freq: number,
    adapter: MessageFormatAdapter
): boolean {
    const prevCount = tracker.toolResultCount
    const newCount = adapter.countToolResults(messages, tracker)
    if (newCount > 0) {
        const prevBucket = Math.floor(prevCount / freq)
        const newBucket = Math.floor(tracker.toolResultCount / freq)
        if (newBucket > prevBucket) {
            adapter.appendNudge(messages, nudgeText)
            return true
        }
    }
    return false
}

// ============================================================================
// OpenAI Chat / Anthropic Format
// ============================================================================

const openaiAdapter: MessageFormatAdapter = {
    countToolResults(messages, tracker) {
        let newCount = 0
        for (const m of messages) {
            if (m.role === 'tool' && m.tool_call_id) {
                const id = String(m.tool_call_id).toLowerCase()
                if (!tracker.seenToolResultIds.has(id)) {
                    tracker.seenToolResultIds.add(id)
                    newCount++
                    const toolName = m.name || tracker.getToolName?.(m.tool_call_id)
                    if (toolName !== 'context_pruning') {
                        tracker.skipNextIdle = false
                    }
                }
            } else if (m.role === 'user' && Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (part.type === 'tool_result' && part.tool_use_id) {
                        const id = String(part.tool_use_id).toLowerCase()
                        if (!tracker.seenToolResultIds.has(id)) {
                            tracker.seenToolResultIds.add(id)
                            newCount++
                            const toolName = tracker.getToolName?.(part.tool_use_id)
                            if (toolName !== 'context_pruning') {
                                tracker.skipNextIdle = false
                            }
                        }
                    }
                }
            }
        }
        tracker.toolResultCount += newCount
        return newCount
    },
    appendNudge(messages, nudgeText) {
        messages.push({ role: 'user', content: nudgeText, synthetic: true })
    }
}

export function isIgnoredUserMessage(msg: any): boolean {
    if (!msg || msg.role !== 'user') return false
    if (msg.ignored || msg.info?.ignored || msg.synthetic) return true
    if (Array.isArray(msg.content) && msg.content.length > 0) {
        if (msg.content.every((part: any) => part?.ignored)) return true
    }
    return false
}

export function injectNudge(messages: any[], tracker: ToolTracker, nudgeText: string, freq: number): boolean {
    return injectNudgeCore(messages, tracker, nudgeText, freq, openaiAdapter)
}

export function injectSynth(messages: any[], instruction: string): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'user' && !isIgnoredUserMessage(msg)) {
            if (typeof msg.content === 'string') {
                if (msg.content.includes(instruction)) return false
                msg.content = msg.content + '\n\n' + instruction
            } else if (Array.isArray(msg.content)) {
                const alreadyInjected = msg.content.some(
                    (part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(instruction)
                )
                if (alreadyInjected) return false
                msg.content.push({ type: 'text', text: instruction })
            }
            return true
        }
    }
    return false
}

// ============================================================================
// Google/Gemini Format (body.contents with parts)
// ============================================================================

const geminiAdapter: MessageFormatAdapter = {
    countToolResults(contents, tracker) {
        let newCount = 0
        for (const content of contents) {
            if (!Array.isArray(content.parts)) continue
            for (const part of content.parts) {
                if (part.functionResponse) {
                    const funcName = part.functionResponse.name?.toLowerCase() || 'unknown'
                    const pseudoId = `gemini:${funcName}:${tracker.seenToolResultIds.size}`
                    if (!tracker.seenToolResultIds.has(pseudoId)) {
                        tracker.seenToolResultIds.add(pseudoId)
                        newCount++
                        if (funcName !== 'context_pruning') {
                            tracker.skipNextIdle = false
                        }
                    }
                }
            }
        }
        tracker.toolResultCount += newCount
        return newCount
    },
    appendNudge(contents, nudgeText) {
        contents.push({ role: 'user', parts: [{ text: nudgeText }] })
    }
}

export function injectNudgeGemini(contents: any[], tracker: ToolTracker, nudgeText: string, freq: number): boolean {
    return injectNudgeCore(contents, tracker, nudgeText, freq, geminiAdapter)
}

export function injectSynthGemini(contents: any[], instruction: string): boolean {
    for (let i = contents.length - 1; i >= 0; i--) {
        const content = contents[i]
        if (content.role === 'user' && Array.isArray(content.parts)) {
            const alreadyInjected = content.parts.some(
                (part: any) => part?.text && typeof part.text === 'string' && part.text.includes(instruction)
            )
            if (alreadyInjected) return false
            content.parts.push({ text: instruction })
            return true
        }
    }
    return false
}

// ============================================================================
// OpenAI Responses API Format (body.input with type-based items)
// ============================================================================

const responsesAdapter: MessageFormatAdapter = {
    countToolResults(input, tracker) {
        let newCount = 0
        for (const item of input) {
            if (item.type === 'function_call_output' && item.call_id) {
                const id = String(item.call_id).toLowerCase()
                if (!tracker.seenToolResultIds.has(id)) {
                    tracker.seenToolResultIds.add(id)
                    newCount++
                    const toolName = item.name || tracker.getToolName?.(item.call_id)
                    if (toolName !== 'context_pruning') {
                        tracker.skipNextIdle = false
                    }
                }
            }
        }
        tracker.toolResultCount += newCount
        return newCount
    },
    appendNudge(input, nudgeText) {
        input.push({ type: 'message', role: 'user', content: nudgeText })
    }
}

export function injectNudgeResponses(input: any[], tracker: ToolTracker, nudgeText: string, freq: number): boolean {
    return injectNudgeCore(input, tracker, nudgeText, freq, responsesAdapter)
}

export function injectSynthResponses(input: any[], instruction: string): boolean {
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i]
        if (item.type === 'message' && item.role === 'user') {
            if (typeof item.content === 'string') {
                if (item.content.includes(instruction)) return false
                item.content = item.content + '\n\n' + instruction
            } else if (Array.isArray(item.content)) {
                const alreadyInjected = item.content.some(
                    (part: any) => part?.type === 'input_text' && typeof part.text === 'string' && part.text.includes(instruction)
                )
                if (alreadyInjected) return false
                item.content.push({ type: 'input_text', text: instruction })
            }
            return true
        }
    }
    return false
}
