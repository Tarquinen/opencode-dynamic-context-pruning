import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { getEffectiveProviderConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { deduplicate, supersedeWrites } from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { checkSession } from "./state"
import { runOnIdle } from "./strategies/on-idle"

export function createChatParamsHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig
) {
    return async (
        input: {
            sessionID: string
            agent: string
            model: { id: string; providerID: string; name: string }
            provider: { source: string; info: any; options: Record<string, any> }
            message: any
        },
        _output: { temperature: number; topP: number; options: Record<string, any> }
    ) => {
        const { model } = input
        const providerID = model.providerID

        // Check if provider changed
        if (state.provider.providerID !== providerID) {
            logger.info("Provider changed", {
                from: state.provider.providerID,
                to: providerID,
                model: model.id
            })

            state.provider.providerID = providerID
            state.provider.modelID = model.id
            state.provider.effectiveConfig = getEffectiveProviderConfig(config, providerID)

            // Show toast if DCP is disabled for this provider (but only once per provider switch)
            if (!state.provider.effectiveConfig.enabled && state.provider.lastNotifiedProvider !== providerID) {
                state.provider.lastNotifiedProvider = providerID
                try {
                    await client.tui.showToast({
                        body: {
                            title: "DCP Disabled",
                            message: `Dynamic Context Pruning is disabled for ${providerID}`,
                            variant: "info",
                            duration: 4000
                        }
                    })
                } catch {
                    // Ignore toast errors
                }
            }
        }
    }
}


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

        if (state.isSubAgent) {
            return
        }

        // Check if DCP is disabled for the current provider
        const effectiveConfig = state.provider.effectiveConfig
        if (effectiveConfig && !effectiveConfig.enabled) {
            logger.info("DCP disabled for provider", { provider: state.provider.providerID })
            return
        }

        syncToolCache(state, config, logger, output.messages);

        // Apply strategies based on effective config (respects provider overrides)
        const strategies = effectiveConfig?.strategies ?? {
            deduplication: config.strategies.deduplication.enabled,
            onIdle: config.strategies.onIdle.enabled,
            pruneTool: config.strategies.pruneTool.enabled,
            supersedeWrites: config.strategies.supersedeWrites.enabled
        }

        if (strategies.deduplication) {
            deduplicate(state, logger, config, output.messages)
        }
        if (strategies.supersedeWrites) {
            supersedeWrites(state, logger, config, output.messages)
        }

        prune(state, logger, config, output.messages)

        if (strategies.pruneTool) {
            insertPruneToolContext(state, config, logger, output.messages)
        }
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
            // Check if onIdle is disabled globally or for current provider
            const effectiveConfig = state.provider.effectiveConfig
            if (effectiveConfig && !effectiveConfig.enabled) {
                return
            }
            if (effectiveConfig && !effectiveConfig.strategies.onIdle) {
                return
            }
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
