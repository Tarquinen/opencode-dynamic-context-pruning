import type { FormatDescriptor, ToolOutput } from "../types"
import type { PluginState } from "../../state"

function isNudgeItem(item: any, nudgeText: string): boolean {
    if (typeof item.content === 'string') {
        return item.content === nudgeText
    }
    return false
}

function injectSynth(input: any[], instruction: string, nudgeText: string): boolean {
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i]
        if (item.type === 'message' && item.role === 'user') {
            if (isNudgeItem(item, nudgeText)) continue

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

function injectPrunableList(input: any[], injection: string): boolean {
    if (!injection) return false
    input.push({ type: 'message', role: 'user', content: injection })
    return true
}

export const openaiResponsesFormat: FormatDescriptor = {
    name: 'openai-responses',

    detect(body: any): boolean {
        return body.input && Array.isArray(body.input)
    },

    getDataArray(body: any): any[] | undefined {
        return body.input
    },

    injectSynth(data: any[], instruction: string, nudgeText: string): boolean {
        return injectSynth(data, instruction, nudgeText)
    },

    injectPrunableList(data: any[], injection: string): boolean {
        return injectPrunableList(data, injection)
    },

    extractToolOutputs(data: any[], state: PluginState): ToolOutput[] {
        const outputs: ToolOutput[] = []

        for (const item of data) {
            if (item.type === 'function_call_output' && item.call_id) {
                const metadata = state.toolParameters.get(item.call_id.toLowerCase())
                outputs.push({
                    id: item.call_id.toLowerCase(),
                    toolName: metadata?.tool ?? item.name
                })
            }
        }

        return outputs
    },

    replaceToolOutput(data: any[], toolId: string, prunedMessage: string, _state: PluginState): boolean {
        const toolIdLower = toolId.toLowerCase()
        let replaced = false

        for (let i = 0; i < data.length; i++) {
            const item = data[i]
            if (item.type === 'function_call_output' && item.call_id?.toLowerCase() === toolIdLower) {
                data[i] = { ...item, output: prunedMessage }
                replaced = true
            }
        }

        return replaced
    },

    replaceToolInput(data: any[], toolId: string, prunedMessage: string, _state: PluginState): boolean {
        const toolIdLower = toolId.toLowerCase()
        let replaced = false

        for (let i = 0; i < data.length; i++) {
            const item = data[i]
            // OpenAI Responses format: function_call items with call_id and arguments
            if (item.type === 'function_call' && item.call_id?.toLowerCase() === toolIdLower) {
                data[i] = { ...item, arguments: JSON.stringify({ _pruned: prunedMessage }) }
                replaced = true
            }
        }

        return replaced
    },

    hasToolOutputs(data: any[]): boolean {
        return data.some((item: any) => item.type === 'function_call_output')
    },

    getLogMetadata(data: any[], replacedCount: number, inputUrl: string): Record<string, any> {
        return {
            url: inputUrl,
            replacedCount,
            totalItems: data.length,
            format: 'openai-responses-api'
        }
    }
}
