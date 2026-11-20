import { getConfig, type PluginConfig } from "../config"
import { Logger } from "../logger"
import { filterMessages } from "../messages/shape"
import {
    createSessionState,
    ensureSessionInitialized,
    type SessionState,
    type WithParts,
} from "../state"
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
    api: TuiApi,
    sessionID: string,
    messages: WithParts[],
    config: PluginConfig,
): Promise<SessionState> {
    const state = createSessionState()
    await ensureSessionInitialized(
        api.client,
        state,
        sessionID,
        logger,
        messages,
        config.manualMode.enabled,
    )
    return state
}

export async function loadSessionData(api: TuiApi, config: PluginConfig) {
    const sessionID = activeSessionID(api)
    if (!sessionID) return undefined

    const messages = sessionMessages(api, sessionID)
    const state = await buildSessionState(api, sessionID, messages, config)
    return { state, messages }
}
