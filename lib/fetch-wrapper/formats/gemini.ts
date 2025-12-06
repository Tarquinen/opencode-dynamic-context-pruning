import type { FormatDescriptor, ToolOutput } from "../types"
import type { PluginState } from "../../state"

function isNudgeContent(content: any, nudgeText: string): boolean {
    if (Array.isArray(content.parts) && content.parts.length === 1) {
        const part = content.parts[0]
        return part?.text === nudgeText
    }
    return false
}

function injectSynth(contents: any[], instruction: string, nudgeText: string): boolean {
    for (let i = contents.length - 1; i >= 0; i--) {
        const content = contents[i]
        if (content.role === 'user' && Array.isArray(content.parts)) {
            if (isNudgeContent(content, nudgeText)) continue

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

function injectPrunableList(contents: any[], injection: string): boolean {
    if (!injection) return false
    contents.push({ role: 'user', parts: [{ text: injection }] })
    return true
}

/**
 * Gemini doesn't include tool call IDs in its native format.
 * We use position-based correlation via state.googleToolCallMapping which maps
 * "toolName:index" -> "toolCallId" (populated by hooks.ts from message events).
 */
export const geminiFormat: FormatDescriptor = {
    name: 'gemini',

    detect(body: any): boolean {
        return body.contents && Array.isArray(body.contents)
    },

    getDataArray(body: any): any[] | undefined {
        return body.contents
    },

    injectSynth(data: any[], instruction: string, nudgeText: string): boolean {
        return injectSynth(data, instruction, nudgeText)
    },

    injectPrunableList(data: any[], injection: string): boolean {
        return injectPrunableList(data, injection)
    },

    extractToolOutputs(data: any[], state: PluginState): ToolOutput[] {
        const outputs: ToolOutput[] = []

        let positionMapping: Map<string, string> | undefined
        for (const [_sessionId, mapping] of state.googleToolCallMapping) {
            if (mapping && mapping.size > 0) {
                positionMapping = mapping
                break
            }
        }

        if (!positionMapping) {
            return outputs
        }

        const toolPositionCounters = new Map<string, number>()

        for (const content of data) {
            if (!Array.isArray(content.parts)) continue

            for (const part of content.parts) {
                if (part.functionResponse) {
                    const funcName = part.functionResponse.name?.toLowerCase()
                    if (funcName) {
                        const currentIndex = toolPositionCounters.get(funcName) || 0
                        toolPositionCounters.set(funcName, currentIndex + 1)

                        const positionKey = `${funcName}:${currentIndex}`
                        const toolCallId = positionMapping.get(positionKey)

                        if (toolCallId) {
                            outputs.push({
                                id: toolCallId.toLowerCase(),
                                toolName: funcName
                            })
                        }
                    }
                }
            }
        }

        return outputs
    },

    replaceToolOutput(data: any[], toolId: string, prunedMessage: string, state: PluginState): boolean {
        let positionMapping: Map<string, string> | undefined
        for (const [_sessionId, mapping] of state.googleToolCallMapping) {
            if (mapping && mapping.size > 0) {
                positionMapping = mapping
                break
            }
        }

        if (!positionMapping) {
            return false
        }

        const toolIdLower = toolId.toLowerCase()
        const toolPositionCounters = new Map<string, number>()
        let replaced = false

        for (let i = 0; i < data.length; i++) {
            const content = data[i]
            if (!Array.isArray(content.parts)) continue

            let contentModified = false
            const newParts = content.parts.map((part: any) => {
                if (part.functionResponse) {
                    const funcName = part.functionResponse.name?.toLowerCase()
                    if (funcName) {
                        const currentIndex = toolPositionCounters.get(funcName) || 0
                        toolPositionCounters.set(funcName, currentIndex + 1)

                        const positionKey = `${funcName}:${currentIndex}`
                        const mappedToolId = positionMapping!.get(positionKey)

                        if (mappedToolId?.toLowerCase() === toolIdLower) {
                            contentModified = true
                            replaced = true
                            // Preserve thoughtSignature if present (required for Gemini 3 Pro)
                            return {
                                ...part,
                                functionResponse: {
                                    ...part.functionResponse,
                                    response: {
                                        name: part.functionResponse.name,
                                        content: prunedMessage
                                    }
                                }
                            }
                        }
                    }
                }
                return part
            })

            if (contentModified) {
                data[i] = { ...content, parts: newParts }
            }
        }

        return replaced
    },

    replaceToolInput(data: any[], toolId: string, prunedMessage: string, state: PluginState): boolean {
        let positionMapping: Map<string, string> | undefined
        for (const [_sessionId, mapping] of state.googleToolCallMapping) {
            if (mapping && mapping.size > 0) {
                positionMapping = mapping
                break
            }
        }

        if (!positionMapping) {
            return false
        }

        const toolIdLower = toolId.toLowerCase()
        const toolPositionCounters = new Map<string, number>()
        let replaced = false

        for (let i = 0; i < data.length; i++) {
            const content = data[i]
            if (!Array.isArray(content.parts)) continue

            let contentModified = false
            const newParts = content.parts.map((part: any) => {
                // Gemini format: functionCall blocks in model content
                if (part.functionCall) {
                    const funcName = part.functionCall.name?.toLowerCase()
                    if (funcName) {
                        const currentIndex = toolPositionCounters.get(funcName) || 0
                        toolPositionCounters.set(funcName, currentIndex + 1)

                        const positionKey = `${funcName}:${currentIndex}`
                        const mappedToolId = positionMapping!.get(positionKey)

                        if (mappedToolId?.toLowerCase() === toolIdLower) {
                            contentModified = true
                            replaced = true
                            return {
                                ...part,
                                functionCall: {
                                    ...part.functionCall,
                                    args: { _pruned: prunedMessage }
                                }
                            }
                        }
                    }
                }
                return part
            })

            if (contentModified) {
                data[i] = { ...content, parts: newParts }
            }
        }

        return replaced
    },

    hasToolOutputs(data: any[]): boolean {
        return data.some((content: any) =>
            Array.isArray(content.parts) &&
            content.parts.some((part: any) => part.functionResponse)
        )
    },

    getLogMetadata(data: any[], replacedCount: number, inputUrl: string): Record<string, any> {
        return {
            url: inputUrl,
            replacedCount,
            totalContents: data.length,
            format: 'google-gemini'
        }
    }
}
