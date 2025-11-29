import { readFileSync } from "fs"
import { join } from "path"

export function loadPrompt(name: string): string {
    const filePath = join(__dirname, "prompts", `${name}.txt`)
    return readFileSync(filePath, "utf8").trim()
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

    return `You are a conversation analyzer that identifies obsolete tool outputs in a coding session.
${reasonContext}
Your task: Analyze the session history and identify tool call IDs whose outputs are NO LONGER RELEVANT to the current conversation context.

Guidelines for identifying obsolete tool calls:
1. Exploratory reads that didn't lead to actual edits or meaningful discussion AND were not explicitly requested to be retained
2. Tool outputs from debugging/fixing an error that has now been resolved
3. Failed or incorrect tool attempts that were immediately corrected (e.g., reading a file from the wrong path, then reading from the correct path)

DO NOT prune:
- Tool calls whose outputs are actively being discussed
- Tool calls that produced errors still being debugged
- Tool calls that are the MOST RECENT activity in the conversation (these may be intended for future use)

IMPORTANT: Available tool call IDs for analysis: ${unprunedToolCallIds.join(", ")}

The session history below may contain tool calls with IDs not in the available list above, these cannot be pruned. These are either:
1. Protected tools (marked with toolCallID "<protected>")
2. Already-pruned tools (marked with toolCallID "<already-pruned>")

ONLY return IDs from the available list above.

Session history (each tool call has a "toolCallID" field):
${messagesJson}

You MUST respond with valid JSON matching this exact schema:
{
  "pruned_tool_call_ids": ["id1", "id2", ...],
  "reasoning": "explanation of why these IDs were selected"
}`
}
