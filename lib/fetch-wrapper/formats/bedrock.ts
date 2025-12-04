import type { FormatDescriptor, ToolOutput } from "../types"
import type { PluginState } from "../../state"
import type { Logger } from "../../logger"
import type { ToolTracker } from "../../api-formats/synth-instruction"
import { cacheToolParametersFromMessages } from "../../state/tool-cache"
import { injectSynth, trackNewToolResults } from "../../api-formats/synth-instruction"
import { injectPrunableList } from "../../api-formats/prunable-list"

/**
 * Format descriptor for AWS Bedrock Converse API.
 * 
 * Bedrock format characteristics:
 * - Top-level `system` array for system messages
 * - `messages` array with only 'user' and 'assistant' roles
 * - `inferenceConfig` for model parameters (maxTokens, temperature, etc.)
 * - Tool calls: `toolUse` blocks in assistant content with `toolUseId`
 * - Tool results: `toolResult` blocks in user content with `toolUseId`
 * - Cache points: `cachePoint` blocks that should be preserved
 */
export const bedrockFormat: FormatDescriptor = {
    name: 'bedrock',

    detect(body: any): boolean {
        // Bedrock has a top-level system array AND inferenceConfig (not model params in messages)
        // This distinguishes it from OpenAI/Anthropic which put system in messages
        return (
            Array.isArray(body.system) &&
            body.inferenceConfig !== undefined &&
            Array.isArray(body.messages)
        )
    },

    getDataArray(body: any): any[] | undefined {
        return body.messages
    },

    cacheToolParameters(data: any[], state: PluginState, logger?: Logger): void {
        // Bedrock stores tool calls in assistant message content as toolUse blocks
        // We need to extract toolUseId and tool name for later correlation
        for (const m of data) {
            if (m.role === 'assistant' && Array.isArray(m.content)) {
                for (const block of m.content) {
                    if (block.toolUse && block.toolUse.toolUseId) {
                        const toolUseId = block.toolUse.toolUseId.toLowerCase()
                        state.toolParameters.set(toolUseId, {
                            tool: block.toolUse.name,
                            parameters: block.toolUse.input
                        })
                        logger?.debug("bedrock", "Cached tool parameters", {
                            toolUseId,
                            toolName: block.toolUse.name
                        })
                    }
                }
            }
        }
        // Also use the generic message caching for any compatible structures
        cacheToolParametersFromMessages(data, state, logger)
    },

    injectSynth(data: any[], instruction: string, nudgeText: string): boolean {
        return injectSynth(data, instruction, nudgeText)
    },

    trackNewToolResults(data: any[], tracker: ToolTracker, protectedTools: Set<string>): number {
        return trackNewToolResults(data, tracker, protectedTools)
    },

    injectPrunableList(data: any[], injection: string): boolean {
        return injectPrunableList(data, injection)
    },

    extractToolOutputs(data: any[], state: PluginState): ToolOutput[] {
        const outputs: ToolOutput[] = []

        for (const m of data) {
            // Bedrock tool results are in user messages as toolResult blocks
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

            // Tool results are in user messages as toolResult blocks
            if (m.role === 'user' && Array.isArray(m.content)) {
                let messageModified = false
                const newContent = m.content.map((block: any) => {
                    if (block.toolResult && block.toolResult.toolUseId?.toLowerCase() === toolIdLower) {
                        messageModified = true
                        // Replace the content array inside toolResult with pruned message
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
