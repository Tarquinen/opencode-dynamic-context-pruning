import type { Logger } from "../../logger"
import type { SessionState, WithParts } from "../../state"
import { filterMessages } from "../shape"
import {
    buildSubagentResultText,
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

interface ExpandablePart {
    part: any
    callID: string
    subAgentSessionId: string
}

// Resuming a subagent with task_id keeps one subagent session alive across
// rounds, so several task results can point at the same session id. Only the
// newest of them describes the subagent's current last reply; for the earlier
// ones that reply belongs to a later round. Overwriting them rewrote history,
// and because the pinning cache lives in session state it was cold on every
// parent turn that followed a session switch (#595).
function collectExpandableParts(messages: WithParts[], state: SessionState): ExpandablePart[] {
    const expandable: ExpandablePart[] = []

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

            const subAgentSessionId = getSubAgentId(part)
            if (!subAgentSessionId) {
                continue
            }

            expandable.push({ part, callID: part.callID, subAgentSessionId })
        }
    }

    const newestIndexBySession = new Map<string, number>()
    expandable.forEach((entry, index) => {
        newestIndexBySession.set(entry.subAgentSessionId, index)
    })

    return expandable.filter(
        (entry, index) => newestIndexBySession.get(entry.subAgentSessionId) === index,
    )
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

    for (const { part, callID, subAgentSessionId } of collectExpandableParts(messages, state)) {
        const cachedResult = state.subAgentResultCache.get(callID)
        if (cachedResult !== undefined) {
            if (cachedResult) {
                part.state.output = stripHallucinationsFromString(
                    mergeSubagentResult(part.state.output, cachedResult),
                    state.idFormat,
                )
            }
            continue
        }

        let subAgentMessages: WithParts[] = []
        try {
            subAgentMessages = await fetchSubAgentMessages(client, subAgentSessionId)
        } catch (error) {
            logger.warn("Failed to fetch subagent session for output expansion", {
                subAgentSessionId,
                callID,
                error: error instanceof Error ? error.message : String(error),
            })
            continue
        }

        const subAgentResultText = buildSubagentResultText(subAgentMessages)
        if (!subAgentResultText) {
            continue
        }

        state.subAgentResultCache.set(callID, subAgentResultText)
        part.state.output = stripHallucinationsFromString(
            mergeSubagentResult(part.state.output, subAgentResultText),
            state.idFormat,
        )
    }
}
