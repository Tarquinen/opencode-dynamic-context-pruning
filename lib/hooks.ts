import type { PluginState } from "./state"
import type { Logger } from "./logger"
import type { JanitorContext } from "./core/janitor"
import { runOnIdle } from "./core/janitor"
import type { PluginConfig, PruningStrategy } from "./config"
import type { ToolTracker } from "./fetch-wrapper/tool-tracker"
import { resetToolTrackerCount } from "./fetch-wrapper/tool-tracker"
import { clearAllMappings } from "./state/id-mapping"

export async function isSubagentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

function toolStrategiesCoveredByIdle(onIdle: PruningStrategy[], onTool: PruningStrategy[]): boolean {
    return onTool.every(strategy => onIdle.includes(strategy))
}

export function createEventHandler(
    client: any,
    janitorCtx: JanitorContext,
    logger: Logger,
    config: PluginConfig,
    toolTracker?: ToolTracker
) {
    return async ({ event }: { event: any }) => {
        if (event.type === "session.status" && event.properties.status.type === "idle") {
            if (await isSubagentSession(client, event.properties.sessionID)) return
            if (config.strategies.onIdle.length === 0) return

            if (toolTracker?.skipNextIdle) {
                toolTracker.skipNextIdle = false
                if (toolStrategiesCoveredByIdle(config.strategies.onIdle, config.strategies.onTool)) {
                    return
                }
            }

            try {
                const result = await runOnIdle(janitorCtx, event.properties.sessionID, config.strategies.onIdle)

                if (result && result.prunedCount > 0 && toolTracker && config.nudge_freq > 0) {
                    if (toolStrategiesCoveredByIdle(config.strategies.onIdle, config.strategies.onTool)) {
                        resetToolTrackerCount(toolTracker)
                    }
                }
            } catch (err: any) {
                logger.error("janitor", "Failed", { error: err.message })
            }
        }
    }
}

/**
 * Creates the chat.params hook for model caching and Google tool call mapping.
 */
export function createChatParamsHandler(
    client: any,
    state: PluginState,
    logger: Logger,
    toolTracker?: ToolTracker
) {
    return async (input: any, _output: any) => {
        const sessionId = input.sessionID
        let providerID = (input.provider as any)?.info?.id || input.provider?.id
        const modelID = input.model?.id

        if (!providerID && input.message?.model?.providerID) {
            providerID = input.message.model.providerID
        }

        if (state.lastSeenSessionId && state.lastSeenSessionId !== sessionId) {
            logger.info("chat.params", "Session changed, resetting state", {
                from: state.lastSeenSessionId,
                to: sessionId
            })
            clearAllMappings()
            state.toolParameters.clear()
            if (toolTracker) {
                resetToolTrackerCount(toolTracker)
            }
        }

        state.lastSeenSessionId = sessionId

        if (!state.checkedSessions.has(sessionId)) {
            state.checkedSessions.add(sessionId)
            const isSubagent = await isSubagentSession(client, sessionId)
            if (isSubagent) {
                state.subagentSessions.add(sessionId)
            }
        }

        // Cache model info for the session (used by janitor for model selection)
        if (providerID && modelID) {
            state.model.set(sessionId, {
                providerID: providerID,
                modelID: modelID
            })
        }

        // Build position-based mapping for Gemini (which loses tool call IDs in native format)
        if (providerID === 'google' || providerID === 'google-vertex') {
            try {
                const messagesResponse = await client.session.messages({
                    path: { id: sessionId },
                    query: { limit: 100 }
                })
                const messages = messagesResponse.data || messagesResponse

                if (Array.isArray(messages)) {
                    const toolCallsByName = new Map<string, string[]>()

                    for (const msg of messages) {
                        if (msg.parts) {
                            for (const part of msg.parts) {
                                if (part.type === 'tool' && part.callID && part.tool) {
                                    const toolName = part.tool.toLowerCase()
                                    const callId = part.callID.toLowerCase()

                                    if (!toolCallsByName.has(toolName)) {
                                        toolCallsByName.set(toolName, [])
                                    }
                                    toolCallsByName.get(toolName)!.push(callId)
                                }
                            }
                        }
                    }

                    const positionMapping = new Map<string, string>()
                    for (const [toolName, callIds] of toolCallsByName) {
                        callIds.forEach((callId, index) => {
                            positionMapping.set(`${toolName}:${index}`, callId)
                        })
                    }

                    state.googleToolCallMapping.set(sessionId, positionMapping)
                    logger.info("chat.params", "Built Google tool call mapping", {
                        sessionId: sessionId.substring(0, 8),
                        toolCount: positionMapping.size,
                        toolParamsCount: state.toolParameters.size
                    })
                }
            } catch (error: any) {
                logger.error("chat.params", "Failed to build Google tool call mapping", {
                    error: error.message
                })
            }
        }
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
