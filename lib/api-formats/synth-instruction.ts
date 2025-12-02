export interface ToolTracker {
    seenToolResultIds: Set<string>
    toolResultCount: number  // Tools since last prune
    skipNextIdle: boolean
    getToolName?: (callId: string) => string | undefined
}

export function createToolTracker(): ToolTracker {
    return { seenToolResultIds: new Set(), toolResultCount: 0, skipNextIdle: false }
}

/** Reset tool count to 0 (called after a prune event) */
export function resetToolTrackerCount(tracker: ToolTracker): void {
    tracker.toolResultCount = 0
}

/** Adapter interface for format-specific message operations */
interface MessageFormatAdapter {
    countToolResults(messages: any[], tracker: ToolTracker): number
    appendNudge(messages: any[], nudgeText: string): void
}

/** Generic nudge injection - nudges every fetch once tools since last prune exceeds freq */
function injectNudgeCore(
    messages: any[],
    tracker: ToolTracker,
    nudgeText: string,
    freq: number,
    adapter: MessageFormatAdapter
): boolean {
    // Count any new tool results
    adapter.countToolResults(messages, tracker)
    
    // Once we've exceeded the threshold, nudge on every fetch
    if (tracker.toolResultCount > freq) {
        adapter.appendNudge(messages, nudgeText)
        return true
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
                    if (toolName !== 'prune') {
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
                            if (toolName !== 'prune') {
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
        messages.push({ role: 'user', content: nudgeText })
    }
}

export function injectNudge(messages: any[], tracker: ToolTracker, nudgeText: string, freq: number): boolean {
    return injectNudgeCore(messages, tracker, nudgeText, freq, openaiAdapter)
}

/** Check if a message content matches nudge text (OpenAI/Anthropic format) */
function isNudgeMessage(msg: any, nudgeText: string): boolean {
    if (typeof msg.content === 'string') {
        return msg.content === nudgeText
    }
    return false
}

export function injectSynth(messages: any[], instruction: string, nudgeText: string): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'user') {
            // Skip nudge messages - find real user message
            if (isNudgeMessage(msg, nudgeText)) continue
            
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
                        if (funcName !== 'prune') {
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

/** Check if a Gemini content matches nudge text */
function isNudgeContentGemini(content: any, nudgeText: string): boolean {
    if (Array.isArray(content.parts) && content.parts.length === 1) {
        const part = content.parts[0]
        return part?.text === nudgeText
    }
    return false
}

export function injectSynthGemini(contents: any[], instruction: string, nudgeText: string): boolean {
    for (let i = contents.length - 1; i >= 0; i--) {
        const content = contents[i]
        if (content.role === 'user' && Array.isArray(content.parts)) {
            // Skip nudge messages - find real user message
            if (isNudgeContentGemini(content, nudgeText)) continue
            
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
                    if (toolName !== 'prune') {
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

/** Check if a Responses API item matches nudge text */
function isNudgeItemResponses(item: any, nudgeText: string): boolean {
    if (typeof item.content === 'string') {
        return item.content === nudgeText
    }
    return false
}

export function injectSynthResponses(input: any[], instruction: string, nudgeText: string): boolean {
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i]
        if (item.type === 'message' && item.role === 'user') {
            // Skip nudge messages - find real user message
            if (isNudgeItemResponses(item, nudgeText)) continue
            
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
