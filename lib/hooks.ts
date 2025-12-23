import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { deduplicate, supersedeWrites } from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { checkSession } from "./state"
import { runOnIdle } from "./strategies/on-idle"


export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig
) {
    return async (
        input: {},
        output: { messages: WithParts[] }
    ) => {
        await checkSession(client, state, logger, output.messages)

        // Sync tool cache for all sessions (needed for prune tool context)
        syncToolCache(state, config, logger, output.messages);

        // Skip automatic pruning strategies for subagents to avoid conflicts
        // but allow manual prune tool usage
        if (!state.isSubAgent) {
            deduplicate(state, logger, config, output.messages)
            supersedeWrites(state, logger, config, output.messages)
        }

        // Apply pending prune actions and inject prune tool context for all sessions
        // This ensures subagents can use the prune tool effectively
        prune(state, logger, config, output.messages)
        insertPruneToolContext(state, config, logger, output.messages)
    }
}

export function createEventHandler(
    client: any,
    config: PluginConfig,
    state: SessionState,
    logger: Logger,
    workingDirectory?: string
) {
    return async (
        { event }: { event: any }
    ) => {
        if (state.sessionId === null || state.isSubAgent) {
            return
        }

        if (event.type === "session.status" && event.properties.status.type === "idle") {
            if (!config.strategies.onIdle.enabled) {
                return
            }
            if (state.lastToolPrune) {
                logger.info("Skipping OnIdle pruning - last tool was prune")
                return
            }

            try {
                await runOnIdle(
                    client,
                    state,
                    logger,
                    config,
                    workingDirectory
                )
            } catch (err: any) {
                logger.error("OnIdle pruning failed", { error: err.message })
            }
        }
    }
}
