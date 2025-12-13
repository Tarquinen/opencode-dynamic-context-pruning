import { readFileSync } from "fs"
import { join } from "path"

export function loadPrompt(name: string, vars?: Record<string, string>): string {
    const filePath = join(__dirname, "prompts", `${name}.txt`)
    let content = readFileSync(filePath, "utf8").trim()
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
        }
    }
    return content
}

function minimizeMessages(messages: any[], alreadyPrunedIds?: string[], protectedToolCallIds?: string[]): any[] {
    const prunedIdsSet = alreadyPrunedIds ? new Set(alreadyPrunedIds.map(id => id.toLowerCase())) : new Set()
    const protectedIdsSet = protectedToolCallIds ? new Set(protectedToolCallIds.map(id => id.toLowerCase())) : new Set()

    return messages.map(msg => {
        const minimized: any = {
            role: msg.info?.role
        }

        if (msg.parts) {
            minimized.parts = msg.parts
                .filter((part: any) => {
                    if (part.type === 'step-start' || part.type === 'step-finish') {
                        return false
                    }
                    return true
                })
                .map((part: any) => {
                    if (part.type === 'text') {
                        if (part.ignored) {
                            return null
                        }
                        return {
                            type: 'text',
                            text: part.text
                        }
                    }

                    // TODO: This should use the opencode normalized system instead of per provider settings
                    if (part.type === 'reasoning') {
                        // Calculate encrypted content size if present
                        let encryptedContentLength = 0
                        if (part.metadata?.openai?.reasoningEncryptedContent) {
                            encryptedContentLength = part.metadata.openai.reasoningEncryptedContent.length
                        } else if (part.metadata?.anthropic?.signature) {
                            encryptedContentLength = part.metadata.anthropic.signature.length
                        } else if (part.metadata?.google?.thoughtSignature) {
                            encryptedContentLength = part.metadata.google.thoughtSignature.length
                        }

                        return {
                            type: 'reasoning',
                            text: part.text,
                            textLength: part.text?.length || 0,
                            encryptedContentLength,
                            ...(part.time && { time: part.time }),
                            ...(part.metadata && { metadataKeys: Object.keys(part.metadata) })
                        }
                    }

                    if (part.type === 'tool') {
                        const callIDLower = part.callID?.toLowerCase()
                        const isAlreadyPruned = prunedIdsSet.has(callIDLower)
                        const isProtected = protectedIdsSet.has(callIDLower)

                        let displayCallID = part.callID
                        if (isAlreadyPruned) {
                            displayCallID = '<already-pruned>'
                        } else if (isProtected) {
                            displayCallID = '<protected>'
                        }

                        const toolPart: any = {
                            type: 'tool',
                            toolCallID: displayCallID,
                            tool: part.tool
                        }

                        if (part.state?.output) {
                            toolPart.output = part.state.output
                        }

                        if (part.state?.input) {
                            const input = part.state.input

                            if (input.filePath && (part.tool === 'write' || part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'patch')) {
                                toolPart.input = input
                            }
                            else if (input.filePath) {
                                toolPart.input = { filePath: input.filePath }
                            }
                            else if (input.tool_calls && Array.isArray(input.tool_calls)) {
                                toolPart.input = {
                                    batch_summary: `${input.tool_calls.length} tool calls`,
                                    tools: input.tool_calls.map((tc: any) => tc.tool)
                                }
                            }
                            else {
                                toolPart.input = input
                            }
                        }

                        return toolPart
                    }

                    return null
                })
                .filter(Boolean)
        }

        return minimized
    }).filter(msg => {
        return msg.parts && msg.parts.length > 0
    })
}

export function buildAnalysisPrompt(
    unprunedToolCallIds: string[],
    messages: any[],
    alreadyPrunedIds?: string[],
    protectedToolCallIds?: string[],
    reason?: string
): string {
    const minimizedMessages = minimizeMessages(messages, alreadyPrunedIds, protectedToolCallIds)
    const messagesJson = JSON.stringify(minimizedMessages, null, 2).replace(/\\n/g, '\n')

    const reasonContext = reason
        ? `\nContext: The AI has requested pruning with the following reason: "${reason}"\nUse this context to inform your decisions about what is most relevant to keep.`
        : ''

    return loadPrompt("pruning", {
        reason_context: reasonContext,
        available_tool_call_ids: unprunedToolCallIds.join(", "),
        session_history: messagesJson
    })
}
