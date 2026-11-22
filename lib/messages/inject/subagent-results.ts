import type { Logger } from "../../logger"
import type { SessionState, WithParts } from "../../state"
import { filterMessages } from "../shape"
import {
    buildSubagentResultText,
    extractTaskResultBody,
    getSubAgentId,
    mergeSubagentResult,
} from "../../subagents/subagent-results"
import { stripHallucinationsFromString } from "../utils"

async function fetchSubAgentMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

export const injectExtendedSubAgentResults = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    allowSubAgents: boolean,
): Promise<void> => {
    if (!allowSubAgents) {
        return
    }

    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []

        for (const part of parts) {
            if (part.type !== "tool" || !["task", "subagent"].includes(part.tool) || !part.callID) {
                continue
            }
            if (state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
                continue
            }

            const cachedResult = state.subAgentResultCache.get(part.callID)
            if (cachedResult !== undefined) {
                if (cachedResult) {
                    part.state.output = stripHallucinationsFromString(
                        mergeSubagentResult(part.state.output, cachedResult),
                        state.idFormat,
                    )
                }
                continue
            }

            const extractedResult = extractTaskResultBody(part.state.output)
            if (extractedResult) {
                state.subAgentResultCache.set(part.callID, extractedResult)
                continue
            }

            const subAgentSessionId = getSubAgentId(part)
            if (!subAgentSessionId) {
                continue
            }

            let subAgentMessages: WithParts[] = []
            try {
                subAgentMessages = await fetchSubAgentMessages(client, subAgentSessionId)
            } catch (error) {
                logger.warn("Failed to fetch subagent session for output expansion", {
                    subAgentSessionId,
                    callID: part.callID,
                    error: error instanceof Error ? error.message : String(error),
                })
                continue
            }

            const subAgentResultText = buildSubagentResultText(subAgentMessages)
            if (!subAgentResultText) {
                continue
            }

            state.subAgentResultCache.set(part.callID, subAgentResultText)
            part.state.output = stripHallucinationsFromString(
                mergeSubagentResult(part.state.output, subAgentResultText),
                state.idFormat,
            )
        }
    }
}
