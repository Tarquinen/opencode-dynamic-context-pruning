import { getConfig, type PluginConfig } from "../config"
import { Logger } from "../logger"
import { filterMessages } from "../messages/shape"
import { createSessionState, type SessionState, type WithParts } from "../state"
import { loadSessionState } from "../state/persistence"
import { findLastCompactionTimestamp, loadPruneMap, loadPruneMessagesState } from "../state/utils"
import type { TuiApi } from "./types"

export const logger = new Logger(false)

export function loadConfig(api: TuiApi): PluginConfig {
    return getConfig({
        client: api.client,
        directory: api.state.path.directory,
        worktree: api.state.path.worktree,
    } as any)
}

export function activeSessionID(api: TuiApi): string | undefined {
    const current = api.route.current
    if (current.name !== "session") return undefined
    const sessionID = current.params?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
}

export function sessionMessages(api: TuiApi, sessionID: string): WithParts[] {
    const messages = api.state.session.messages(sessionID)
    return filterMessages(
        messages.map((info) => ({
            info,
            parts: api.state.part(info.id),
        })) as unknown as WithParts[],
    )
}

export async function buildSessionState(
    sessionID: string,
    messages: WithParts[],
    config: PluginConfig,
): Promise<SessionState> {
    const state = createSessionState()
    state.sessionId = sessionID
    state.manualMode = config.manualMode.enabled ? "active" : false
    state.lastCompaction = findLastCompactionTimestamp(messages)

    const persisted = await loadSessionState(sessionID, logger)
    if (persisted) {
        if (typeof persisted.manualMode === "boolean") {
            state.manualMode = persisted.manualMode ? "active" : false
        }

        state.prune.tools = loadPruneMap(persisted.prune.tools)
        state.prune.messages = await loadPruneMessagesState(persisted.prune.messages)
        state.nudges.contextLimitAnchors = new Set(persisted.nudges.contextLimitAnchors || [])
        state.nudges.turnNudgeAnchors = new Set(persisted.nudges.turnNudgeAnchors || [])
        state.nudges.iterationNudgeAnchors = new Set(persisted.nudges.iterationNudgeAnchors || [])
        state.stats = {
            pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
            totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
        }
    }

    return state
}

export async function loadSessionData(api: TuiApi, config: PluginConfig) {
    const sessionID = activeSessionID(api)
    if (!sessionID) return undefined

    const messages = sessionMessages(api, sessionID)
    const state = await buildSessionState(sessionID, messages, config)
    return { state, messages }
}
