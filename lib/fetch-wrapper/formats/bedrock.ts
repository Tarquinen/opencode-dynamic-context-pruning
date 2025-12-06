import type { FormatDescriptor, ToolOutput } from "../types"
import type { PluginState } from "../../state"

function isNudgeMessage(msg: any, nudgeText: string): boolean {
    if (typeof msg.content === 'string') {
        return msg.content === nudgeText
    }
    return false
}

function injectSynth(messages: any[], instruction: string, nudgeText: string): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'user') {
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

function injectPrunableList(messages: any[], injection: string): boolean {
    if (!injection) return false
    messages.push({ role: 'user', content: injection })
    return true
}

/**
 * Bedrock uses top-level `system` array + `inferenceConfig` (distinguishes from OpenAI/Anthropic).
 * Tool calls: `toolUse` blocks in assistant content with `toolUseId`
 * Tool results: `toolResult` blocks in user content with `toolUseId`
 */
export const bedrockFormat: FormatDescriptor = {
    name: 'bedrock',

    detect(body: any): boolean {
        return (
            Array.isArray(body.system) &&
            body.inferenceConfig !== undefined &&
            Array.isArray(body.messages)
        )
    },

    getDataArray(body: any): any[] | undefined {
        return body.messages
    },

    injectSynth(data: any[], instruction: string, nudgeText: string): boolean {
        return injectSynth(data, instruction, nudgeText)
    },

    injectPrunableList(data: any[], injection: string): boolean {
        return injectPrunableList(data, injection)
    },

    extractToolOutputs(data: any[], state: PluginState): ToolOutput[] {
        const outputs: ToolOutput[] = []

        for (const m of data) {
            if (m.role === 'user' && Array.isArray(m.content)) {
                for (const block of m.content) {
                    if (block.toolResult && block.toolResult.toolUseId) {
                        const toolUseId = block.toolResult.toolUseId.toLowerCase()
                        const metadata = state.toolParameters.get(toolUseId)
                        outputs.push({
                            id: toolUseId,
                            toolName: metadata?.tool
                        })
                    }
                }
            }
        }

        return outputs
    },

    replaceToolOutput(data: any[], toolId: string, prunedMessage: string, _state: PluginState): boolean {
        const toolIdLower = toolId.toLowerCase()
        let replaced = false

        for (let i = 0; i < data.length; i++) {
            const m = data[i]

            if (m.role === 'user' && Array.isArray(m.content)) {
                let messageModified = false
                const newContent = m.content.map((block: any) => {
                    if (block.toolResult && block.toolResult.toolUseId?.toLowerCase() === toolIdLower) {
                        messageModified = true
                        return {
                            ...block,
                            toolResult: {
                                ...block.toolResult,
                                content: [{ text: prunedMessage }]
                            }
                        }
                    }
                    return block
                })
                if (messageModified) {
                    data[i] = { ...m, content: newContent }
                    replaced = true
                }
            }
        }

        return replaced
    },

    replaceToolInput(data: any[], toolId: string, prunedMessage: string, _state: PluginState): boolean {
        const toolIdLower = toolId.toLowerCase()
        let replaced = false

        for (let i = 0; i < data.length; i++) {
            const m = data[i]

            // Bedrock format: assistant message with toolUse blocks in content
            if (m.role === 'assistant' && Array.isArray(m.content)) {
                let messageModified = false
                const newContent = m.content.map((block: any) => {
                    if (block.toolUse && block.toolUse.toolUseId?.toLowerCase() === toolIdLower) {
                        messageModified = true
                        return {
                            ...block,
                            toolUse: {
                                ...block.toolUse,
                                input: { _pruned: prunedMessage }
                            }
                        }
                    }
                    return block
                })
                if (messageModified) {
                    data[i] = { ...m, content: newContent }
                    replaced = true
                }
            }
        }

        return replaced
    },

    hasToolOutputs(data: any[]): boolean {
        for (const m of data) {
            if (m.role === 'user' && Array.isArray(m.content)) {
                for (const block of m.content) {
                    if (block.toolResult) return true
                }
            }
        }
        return false
    },

    getLogMetadata(data: any[], replacedCount: number, inputUrl: string): Record<string, any> {
        return {
            url: inputUrl,
            replacedCount,
            totalMessages: data.length,
            format: 'bedrock'
        }
    }
}
