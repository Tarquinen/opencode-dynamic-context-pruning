import type { SessionStats, GCStats } from "../core/janitor"
import type { Logger } from "../logger"
import { loadSessionState } from "./persistence"

export interface PluginState {
    prunedIds: Map<string, string[]>
    stats: Map<string, SessionStats>
    gcPending: Map<string, GCStats>
    toolParameters: Map<string, ToolParameterEntry>
    model: Map<string, ModelInfo>
    googleToolCallMapping: Map<string, Map<string, string>>
    restoredSessions: Set<string>
    checkedSessions: Set<string>
    subagentSessions: Set<string>
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

export function createPluginState(): PluginState {
    return {
        prunedIds: new Map(),
        stats: new Map(),
        gcPending: new Map(),
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
            const stats: SessionStats = {
                totalToolsPruned: persisted.stats.totalToolsPruned,
                totalTokensSaved: persisted.stats.totalTokensSaved,
                totalGCTokens: persisted.stats.totalGCTokens ?? 0
            }
            state.stats.set(sessionId, stats)
        }
    }
}
