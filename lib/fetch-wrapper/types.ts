import type { PluginState } from "../state"
import type { Logger } from "../logger"
import type { ToolTracker } from "../synth-instruction"
import type { PluginConfig } from "../config"

/** The message used to replace pruned tool output content */
export const PRUNED_CONTENT_MESSAGE = '[Output removed to save context - information superseded or no longer needed]'

/** Prompts used for synthetic instruction injection */
export interface SynthPrompts {
    synthInstruction: string
    nudgeInstruction: string
}

/** Context passed to each format-specific handler */
export interface FetchHandlerContext {
    state: PluginState
    logger: Logger
    client: any
    config: PluginConfig
    toolTracker: ToolTracker
    prompts: SynthPrompts
}

/** Result from a format handler indicating what happened */
export interface FetchHandlerResult {
    /** Whether the body was modified and should be re-serialized */
    modified: boolean
    /** The potentially modified body object */
    body: any
}

/** Session data returned from getAllPrunedIds */
export interface PrunedIdData {
    allSessions: any
    allPrunedIds: Set<string>
}

/**
 * Get all pruned IDs across all non-subagent sessions.
 */
export async function getAllPrunedIds(
    client: any,
    state: PluginState
): Promise<PrunedIdData> {
    const allSessions = await client.session.list()
    const allPrunedIds = new Set<string>()

    if (allSessions.data) {
        for (const session of allSessions.data) {
            if (session.parentID) continue
            const prunedIds = state.prunedIds.get(session.id) ?? []
            prunedIds.forEach((id: string) => allPrunedIds.add(id))
        }
    }

    return { allSessions, allPrunedIds }
}

/**
 * Fetch session messages for logging purposes.
 */
export async function fetchSessionMessages(
    client: any,
    sessionId: string
): Promise<any[] | undefined> {
    try {
        const messagesResponse = await client.session.messages({
            path: { id: sessionId },
            query: { limit: 100 }
        })
        return Array.isArray(messagesResponse.data)
            ? messagesResponse.data
            : Array.isArray(messagesResponse) ? messagesResponse : undefined
    } catch (e) {
        return undefined
    }
}

/**
 * Get the most recent active (non-subagent) session.
 */
export function getMostRecentActiveSession(allSessions: any): any | undefined {
    const activeSessions = allSessions.data?.filter((s: any) => !s.parentID) || []
    return activeSessions.length > 0 ? activeSessions[0] : undefined
}
