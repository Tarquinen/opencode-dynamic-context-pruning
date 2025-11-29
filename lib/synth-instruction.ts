export interface ToolTracker {
    seenToolResultIds: Set<string>
    toolResultCount: number
}

export function createToolTracker(): ToolTracker {
    return {
        seenToolResultIds: new Set(),
        toolResultCount: 0
    }
}

// ============================================================================
// OpenAI Chat / Anthropic Format
// ============================================================================

function countToolResults(messages: any[], tracker: ToolTracker): number {
    let newCount = 0

    for (const m of messages) {
        if (m.role === 'tool' && m.tool_call_id) {
            const id = String(m.tool_call_id).toLowerCase()
            if (!tracker.seenToolResultIds.has(id)) {
                tracker.seenToolResultIds.add(id)
                newCount++
            }
        } else if (m.role === 'user' && Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === 'tool_result' && part.tool_use_id) {
                    const id = String(part.tool_use_id).toLowerCase()
                    if (!tracker.seenToolResultIds.has(id)) {
                        tracker.seenToolResultIds.add(id)
                        newCount++
                    }
                }
            }
        }
    }

    tracker.toolResultCount += newCount
    return newCount
}

/**
 * Counts new tool results and injects nudge instruction every N tool results.
 * Returns true if injection happened.
 */
export function injectNudge(
    messages: any[],
    tracker: ToolTracker,
    nudgeText: string,
    freq: number
): boolean {
    const prevCount = tracker.toolResultCount
    const newCount = countToolResults(messages, tracker)
    
    if (newCount > 0) {
        // Check if we crossed a multiple of freq
        const prevBucket = Math.floor(prevCount / freq)
        const newBucket = Math.floor(tracker.toolResultCount / freq)
        if (newBucket > prevBucket) {
            // Inject at the END of messages so it's in immediate context
            return appendNudge(messages, nudgeText)
        }
    }
    return false
}

export function isIgnoredUserMessage(msg: any): boolean {
    if (!msg || msg.role !== 'user') {
        return false
    }

    // Skip ignored or synthetic messages
    if (msg.ignored || msg.info?.ignored || msg.synthetic) {
        return true
    }

    if (Array.isArray(msg.content) && msg.content.length > 0) {
        const allPartsIgnored = msg.content.every((part: any) => part?.ignored)
        if (allPartsIgnored) {
            return true
        }
    }

    return false
}

/**
 * Appends a nudge message at the END of the messages array as a new user message.
 * This ensures it's in the model's immediate context, not buried in old messages.
 */
function appendNudge(messages: any[], nudgeText: string): boolean {
    messages.push({
        role: 'user',
        content: nudgeText,
        synthetic: true
    })
    return true
}

export function injectSynth(messages: any[], instruction: string): boolean {
    // Find the last user message that is not ignored
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'user' && !isIgnoredUserMessage(msg)) {
            // Avoid double-injecting the same instruction
            if (typeof msg.content === 'string') {
                if (msg.content.includes(instruction)) {
                    return false
                }
                msg.content = msg.content + '\n\n' + instruction
            } else if (Array.isArray(msg.content)) {
                const alreadyInjected = msg.content.some(
                    (part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(instruction)
                )
                if (alreadyInjected) {
                    return false
                }
                msg.content.push({
                    type: 'text',
                    text: instruction
                })
            }
            return true
        }
    }
    return false
}

// ============================================================================
// Google/Gemini Format (body.contents with parts)
// ============================================================================

function countToolResultsGemini(contents: any[], tracker: ToolTracker): number {
    let newCount = 0

    for (const content of contents) {
        if (!Array.isArray(content.parts)) continue

        for (const part of content.parts) {
            if (part.functionResponse) {
                // Use function name + index as a pseudo-ID since Gemini doesn't have tool call IDs
                const funcName = part.functionResponse.name?.toLowerCase() || 'unknown'
                const pseudoId = `gemini:${funcName}:${tracker.seenToolResultIds.size}`
                if (!tracker.seenToolResultIds.has(pseudoId)) {
                    tracker.seenToolResultIds.add(pseudoId)
                    newCount++
                }
            }
        }
    }

    tracker.toolResultCount += newCount
    return newCount
}

/**
 * Counts new tool results and injects nudge instruction every N tool results (Gemini format).
 * Returns true if injection happened.
 */
export function injectNudgeGemini(
    contents: any[],
    tracker: ToolTracker,
    nudgeText: string,
    freq: number
): boolean {
    const prevCount = tracker.toolResultCount
    const newCount = countToolResultsGemini(contents, tracker)

    if (newCount > 0) {
        const prevBucket = Math.floor(prevCount / freq)
        const newBucket = Math.floor(tracker.toolResultCount / freq)
        if (newBucket > prevBucket) {
            return appendNudgeGemini(contents, nudgeText)
        }
    }
    return false
}

function appendNudgeGemini(contents: any[], nudgeText: string): boolean {
    contents.push({
        role: 'user',
        parts: [{ text: nudgeText }]
    })
    return true
}

export function injectSynthGemini(contents: any[], instruction: string): boolean {
    // Find the last user content that is not ignored
    for (let i = contents.length - 1; i >= 0; i--) {
        const content = contents[i]
        if (content.role === 'user' && Array.isArray(content.parts)) {
            // Check if already injected
            const alreadyInjected = content.parts.some(
                (part: any) => part?.text && typeof part.text === 'string' && part.text.includes(instruction)
            )
            if (alreadyInjected) {
                return false
            }
            content.parts.push({ text: instruction })
            return true
        }
    }
    return false
}

// ============================================================================
// OpenAI Responses API Format (body.input with type-based items)
// ============================================================================

function countToolResultsResponses(input: any[], tracker: ToolTracker): number {
    let newCount = 0

    for (const item of input) {
        if (item.type === 'function_call_output' && item.call_id) {
            const id = String(item.call_id).toLowerCase()
            if (!tracker.seenToolResultIds.has(id)) {
                tracker.seenToolResultIds.add(id)
                newCount++
            }
        }
    }

    tracker.toolResultCount += newCount
    return newCount
}

/**
 * Counts new tool results and injects nudge instruction every N tool results (Responses API format).
 * Returns true if injection happened.
 */
export function injectNudgeResponses(
    input: any[],
    tracker: ToolTracker,
    nudgeText: string,
    freq: number
): boolean {
    const prevCount = tracker.toolResultCount
    const newCount = countToolResultsResponses(input, tracker)

    if (newCount > 0) {
        const prevBucket = Math.floor(prevCount / freq)
        const newBucket = Math.floor(tracker.toolResultCount / freq)
        if (newBucket > prevBucket) {
            return appendNudgeResponses(input, nudgeText)
        }
    }
    return false
}

function appendNudgeResponses(input: any[], nudgeText: string): boolean {
    input.push({
        type: 'message',
        role: 'user',
        content: nudgeText
    })
    return true
}

export function injectSynthResponses(input: any[], instruction: string): boolean {
    // Find the last user message in the input array
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i]
        if (item.type === 'message' && item.role === 'user') {
            // Check if already injected
            if (typeof item.content === 'string') {
                if (item.content.includes(instruction)) {
                    return false
                }
                item.content = item.content + '\n\n' + instruction
            } else if (Array.isArray(item.content)) {
                const alreadyInjected = item.content.some(
                    (part: any) => part?.type === 'input_text' && typeof part.text === 'string' && part.text.includes(instruction)
                )
                if (alreadyInjected) {
                    return false
                }
                item.content.push({
                    type: 'input_text',
                    text: instruction
                })
            }
            return true
        }
    }
    return false
}
