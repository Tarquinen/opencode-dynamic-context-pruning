import { SessionState, WithParts } from "../state"
import { UserMessage } from "@opencode-ai/sdk"
import { Logger } from "../logger"
import { encode } from 'gpt-tokenizer'
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"

export function getCurrentParams(
    messages: WithParts[],
    logger: Logger
): {
    providerId: string | undefined,
    modelId: string | undefined,
    agent: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return { providerId: undefined, modelId: undefined, agent: undefined }
    }
    const agent: string = (userMsg.info as UserMessage).agent
    const providerId: string | undefined = (userMsg.info as UserMessage).model.providerID
    const modelId: string | undefined = (userMsg.info as UserMessage).model.modelID

    return { providerId, modelId, agent }
}

/**
 * Estimates token counts for a batch of texts using gpt-tokenizer.
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
 */
export const calculateTokensSaved = (
    state: SessionState,
    messages: WithParts[],
    pruneToolIds: string[]
): number => {
    try {
        const contents: string[] = []
        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue
            }
            for (const part of msg.parts) {
                if (part.type !== 'tool' || !pruneToolIds.includes(part.callID)) {
                    continue
                }
                // For write and edit tools, count input content as that is all we prune for these tools
                // (input is present in both completed and error states)
                if (part.tool === "write" || part.tool === "edit") {
                    const inputContent = part.state.input?.content
                    const content = typeof inputContent === 'string'
                        ? inputContent
                        : JSON.stringify(inputContent ?? '')
                    contents.push(content)
                    continue
                }
                // For other tools, count output or error based on status
                if (part.state.status === "completed") {
                    const content = typeof part.state.output === 'string'
                        ? part.state.output
                        : JSON.stringify(part.state.output)
                    contents.push(content)
                } else if (part.state.status === "error") {
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
