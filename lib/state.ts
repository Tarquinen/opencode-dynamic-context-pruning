import type { SessionStats } from "./janitor"
import type { Logger } from "./logger"
import { loadSessionState } from "./state-persistence"

/**
 * Centralized state management for the DCP plugin.
 * All mutable state is stored here and shared across modules.
 */
export interface PluginState {
    /** Map of session IDs to arrays of pruned tool call IDs */
    prunedIds: Map<string, string[]>
    /** Map of session IDs to session statistics */
    stats: Map<string, SessionStats>
    /** Cache of tool call IDs to their parameters */
    toolParameters: Map<string, ToolParameterEntry>
    /** Cache of session IDs to their model info */
    model: Map<string, ModelInfo>
    /** 
     * Maps Google/Gemini tool positions to OpenCode tool call IDs for correlation.
     * Key: sessionID, Value: Map<positionKey, toolCallId> where positionKey is "toolName:index"
     */
    googleToolCallMapping: Map<string, Map<string, string>>
    /** Set of session IDs that have been restored from disk */
    restoredSessions: Set<string>
    /** Set of session IDs we've already checked for subagent status (to avoid redundant API calls) */
    checkedSessions: Set<string>
    /** Set of session IDs that are subagents (have a parentID) - used to skip fetch wrapper processing */
    subagentSessions: Set<string>
    /** The most recent session ID seen in chat.params - used to correlate fetch requests */
    lastSeenSessionId: string | null
}

export interface ToolParameterEntry {
    tool: string
    parameters: any
}

export interface ModelInfo {
    providerID: string
    modelID: string
}

/**
 * Creates a fresh plugin state instance.
 */
export function createPluginState(): PluginState {
    return {
        prunedIds: new Map(),
        stats: new Map(),
        toolParameters: new Map(),
        model: new Map(),
        googleToolCallMapping: new Map(),
        restoredSessions: new Set(),
        checkedSessions: new Set(),
        subagentSessions: new Set(),
        lastSeenSessionId: null,
    }
}

export async function ensureSessionRestored(
    state: PluginState,
    sessionId: string,
    logger?: Logger
): Promise<void> {
    if (state.restoredSessions.has(sessionId)) {
        return
    }

    state.restoredSessions.add(sessionId)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted) {
        if (!state.prunedIds.has(sessionId)) {
            state.prunedIds.set(sessionId, persisted.prunedIds)
            logger?.info("persist", "Restored prunedIds from disk", {
                sessionId: sessionId.slice(0, 8),
                count: persisted.prunedIds.length,
            })
        }
        if (!state.stats.has(sessionId)) {
            state.stats.set(sessionId, persisted.stats)
        }
    }
}
