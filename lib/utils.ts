import { WithParts } from "./state"
import { encode } from 'gpt-tokenizer'

/**
 * Estimates token counts for a batch of texts using gpt-tokenizer.
 * TODO: ensure we aren't falling back to catch branch
 */
function estimateTokensBatch(texts: string[]): number[] {
    try {
        return texts.map(text => encode(text).length)
    } catch {
        return texts.map(text => Math.round(text.length / 4))
    }
}

/**
 * Calculates approximate tokens saved by pruning the given tool call IDs.
 * Uses pre-fetched messages to avoid duplicate API calls.
 * TODO: Make it count message content that are not tool outputs. Currently it ONLY covers tool outputs and errors
 */
export const calculateTokensSaved = (
    messages: WithParts[],
    pruneToolIds: string[]
): number => {
    try {
        const contents: string[] = []
        for (const msg of messages) {
            for (const part of msg.parts) {
                if (part.type !== 'tool' || !pruneToolIds.includes(part.callID)) {
                    continue
                }
                if (part.state.status === "completed") {
                    const content = typeof part.state.output === 'string'
                        ? part.state.output
                        : JSON.stringify(part.state.output)
                    contents.push(content)
                }
                if (part.state.status === "error") {
                    const content = typeof part.state.error === 'string'
                        ? part.state.error
                        : JSON.stringify(part.state.error)
                    contents.push(content)
                }
            }
        }
        const tokenCounts: number[] = estimateTokensBatch(contents)
        return tokenCounts.reduce((sum, count) => sum + count, 0)
    } catch (error: any) {
        return 0
    }
}

export function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace('.0K', 'K') + ' tokens'
    }
    return tokens.toString() + ' tokens'
}

/**
 * Checks if a session is a subagent session by looking for a parentID.
 */
export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

/**
 * Finds the current agent from messages by scanning backward for user messages.
 */
export function findCurrentAgent(messages: any[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const info = msg.info
        if (info?.role === 'user') {
            return info.agent || 'build'
        }
    }
    return undefined
}

/**
 * Builds a list of tool call IDs from messages.
 */
export function buildToolIdList(messages: WithParts[]): string[] {
    const toolIds: string[] = []
    for (const msg of messages) {
        if (msg.parts) {
            for (const part of msg.parts) {
                if (part.type === 'tool' && part.callID && part.tool) {
                    toolIds.push(part.callID)
                }
            }
        }
    }
    return toolIds
}

/**
 * Prunes numeric tool IDs to valid tool call IDs based on the provided tool ID list.
 */
export function getPruneToolIds(numericToolIds: number[], toolIdList: string[]): string[] {
    const pruneToolIds: string[] = []
    for (const index of numericToolIds) {
        if (!isNaN(index) && index >= 0 && index < toolIdList.length) {
            pruneToolIds.push(toolIdList[index])
        }
    }
    return pruneToolIds
}
