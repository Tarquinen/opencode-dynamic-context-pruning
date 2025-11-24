/**
 * Minimize message structure for AI analysis - keep only what's needed
 * to determine if tool calls are obsolete
 * Also replaces callIDs of already-pruned tools with "<already-pruned>"
 * and protected tools with "<protected>"
 */
function minimizeMessages(messages: any[], alreadyPrunedIds?: string[], protectedToolCallIds?: string[]): any[] {
    const prunedIdsSet = alreadyPrunedIds ? new Set(alreadyPrunedIds.map(id => id.toLowerCase())) : new Set()
    const protectedIdsSet = protectedToolCallIds ? new Set(protectedToolCallIds.map(id => id.toLowerCase())) : new Set()

    return messages.map(msg => {
        const minimized: any = {
            role: msg.info?.role
        }

        // Keep essential parts only
        if (msg.parts) {
            minimized.parts = msg.parts
                .filter((part: any) => {
                    // Completely remove step markers - they add no value for janitor
                    if (part.type === 'step-start' || part.type === 'step-finish') {
                        return false
                    }
                    return true
                })
                .map((part: any) => {
                    // For text parts, keep the text content (needed for user intent & retention requests)
                    if (part.type === 'text') {
                        // Filter out ignored messages (e.g., DCP summary UI messages)
                        if (part.ignored) {
                            return null
                        }
                        return {
                            type: 'text',
                            text: part.text
                        }
                    }

                    // For tool parts, keep what's needed for pruning decisions
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

                        // Keep the actual output - janitor needs to see what was returned
                        if (part.state?.output) {
                            toolPart.output = part.state.output
                        }

                        // Include minimal input for deduplication context
                        // Only keep resource identifiers, not full nested structures
                        if (part.state?.input) {
                            const input = part.state.input

                            // For write/edit tools, keep file path AND content (what was changed matters)
                            // These tools: write, edit, multiedit, patch
                            if (input.filePath && (part.tool === 'write' || part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'patch')) {
                                toolPart.input = input // Keep full input (content, oldString, newString, etc.)
                            }
                            // For read-only file operations, just keep the file path
                            else if (input.filePath) {
                                toolPart.input = { filePath: input.filePath }
                            }
                            // For batch operations, summarize instead of full array
                            else if (input.tool_calls && Array.isArray(input.tool_calls)) {
                                toolPart.input = {
                                    batch_summary: `${input.tool_calls.length} tool calls`,
                                    tools: input.tool_calls.map((tc: any) => tc.tool)
                                }
                            }
                            // For other operations, keep minimal input
                            else {
                                toolPart.input = input
                            }
                        }

                        return toolPart
                    }

                    // Skip all other part types (they're not relevant to pruning)
                    return null
                })
                .filter(Boolean) // Remove nulls
        }

        return minimized
    }).filter(msg => {
        // Filter out messages that have no parts (e.g., only contained ignored messages)
        return msg.parts && msg.parts.length > 0
    })
}

export function buildAnalysisPrompt(unprunedToolCallIds: string[], messages: any[], protectedTools: string[], alreadyPrunedIds?: string[], protectedToolCallIds?: string[]): string {
    // Minimize messages to reduce token usage, passing already-pruned and protected IDs for replacement
    const minimizedMessages = minimizeMessages(messages, alreadyPrunedIds, protectedToolCallIds)

    // Stringify with pretty-printing, then replace escaped newlines with actual newlines
    // This makes the logged prompts much more readable
    const messagesJson = JSON.stringify(minimizedMessages, null, 2).replace(/\\n/g, '\n')

    return `You are a conversation analyzer that identifies obsolete tool outputs in a coding session.

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
