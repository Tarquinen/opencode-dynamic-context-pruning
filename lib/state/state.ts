import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { loadSessionState } from "./persistence"
import { getLastUserMessage } from "../messages/utils"
import { isSubAgentSession } from "../utils"

export const checkSession = (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[]
) => {

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        ensureSessionInitialized(
            client,
            state,
            lastSessionId,
            logger
        ).catch((err) => {
            logger.error("Failed to initialize session state", { error: err.message })
        } )
    }
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        prune: {
            toolIds: []
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        nudgeCounter: 0,
        lastToolPrune: false
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.prune = {
        toolIds: []
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    state.toolParameters.clear()
    state.nudgeCounter = 0
    state.lastToolPrune = false
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger
): Promise<void> {
    if (state.sessionId === sessionId) {
        return;
    }

    logger.info("session ID = " + sessionId)
    logger.info("Initializing session state", { sessionId: sessionId })

    // Clear previous session data
    resetSessionState(state)
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    logger.info("isSubAgent = " + isSubAgent)

    // Load session data from storage
    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        return;
    }

    // Populate state with loaded data
    state.prune = {
        toolIds: persisted.prune.toolIds || []
    }
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }
}
