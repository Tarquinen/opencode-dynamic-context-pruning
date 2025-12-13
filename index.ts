import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { createPruneTool } from "./lib/strategies"
import { createChatMessageTransformHandler, createEventHandler } from "./lib/hooks"

const plugin: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    // Suppress AI SDK warnings
    if (typeof globalThis !== 'undefined') {
        (globalThis as any).AI_SDK_LOG_WARNINGS = false
    }

    // Initialize core components
    const logger = new Logger(config.debug)
    const state = createSessionState()

    // Log initialization
    logger.info("DCP initialized", {
        strategies: config.strategies,
    })

    return {
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            state,
            logger,
            config
        ),
        tool: config.strategies.pruneTool.enabled ? {
            prune: createPruneTool({
                client: ctx.client,
                state,
                logger,
                config,
                workingDirectory: ctx.directory
            }),
        } : undefined,
        config: async (opencodeConfig) => {
            // Add prune to primary_tools by mutating the opencode config
            // This works because config is cached and passed by reference
            if (config.strategies.pruneTool.enabled) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, "prune"],
                }
                logger.info("Added 'prune' to experimental.primary_tools via config mutation")
            }
        },
        event: createEventHandler(ctx.client, config, state, logger, ctx.directory),
    }
}) satisfies Plugin

export default plugin
