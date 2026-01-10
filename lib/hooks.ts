import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { deduplicate, supersedeWrites, purgeErrors, autoPrune } from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { checkSession } from "./state"

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        await checkSession(client, state, logger, output.messages)

        if (state.isSubAgent) {
            return
        }

        syncToolCache(state, config, logger, output.messages)

        deduplicate(state, logger, config, output.messages)
        supersedeWrites(state, logger, config, output.messages)
        purgeErrors(state, logger, config, output.messages)

        // Run auto-prune if pinning mode is enabled
        if (config.tools.pinningMode.enabled) {
            await autoPrune(client, state, logger, config, output.messages, workingDirectory)
        }

        prune(state, logger, config, output.messages)

        insertPruneToolContext(state, config, logger, output.messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}
