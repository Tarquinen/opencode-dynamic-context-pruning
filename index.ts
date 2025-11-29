import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { Janitor } from "./lib/janitor"
import { checkForUpdates } from "./lib/version-checker"
import { createPluginState } from "./lib/state"
import { installFetchWrapper } from "./lib/fetch-wrapper"
import { createPruningTool } from "./lib/pruning-tool"
import { createEventHandler, createChatParamsHandler } from "./lib/hooks"
import { createToolTracker } from "./lib/synth-instruction"
import { loadPrompt } from "./lib/prompt"

const plugin: Plugin = (async (ctx) => {
    const { config, migrations } = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    // Suppress AI SDK warnings
    if (typeof globalThis !== 'undefined') {
        (globalThis as any).AI_SDK_LOG_WARNINGS = false
    }

    // Initialize core components
    const logger = new Logger(config.debug)
    const state = createPluginState()
    
    const janitor = new Janitor(
        ctx.client,
        state.prunedIds,
        state.stats,
        logger,
        state.toolParameters,
        config.protectedTools,
        state.model,
        config.model,
        config.showModelErrorToasts,
        config.strictModelSelection,
        config.pruning_summary,
        ctx.directory
    )

    // Create tool tracker and load prompts for synthetic instruction injection
    const toolTracker = createToolTracker()
    const prompts = {
        synthInstruction: loadPrompt("synthetic"),
        nudgeInstruction: loadPrompt("nudge")
    }

    // Install global fetch wrapper for context pruning and synthetic instruction injection
    installFetchWrapper(state, logger, ctx.client, config, toolTracker, prompts)

    // Log initialization
    logger.info("plugin", "DCP initialized", {
        strategies: config.strategies,
        model: config.model || "auto"
    })

    // Check for updates after a delay
    setTimeout(() => {
        checkForUpdates(ctx.client, logger).catch(() => {})
    }, 5000)

    // Show migration toast if there were config migrations
    if (migrations.length > 0) {
        setTimeout(async () => {
            try {
                await ctx.client.tui.showToast({
                    body: {
                        title: "DCP: Config upgraded",
                        message: migrations.join('\n'),
                        variant: "info",
                        duration: 8000
                    }
                })
            } catch {
                // Silently ignore toast errors
            }
        }, 7000)
    }

    return {
        event: createEventHandler(ctx.client, janitor, logger, config),
        "chat.params": createChatParamsHandler(ctx.client, state, logger),
        tool: config.strategies.onTool.length > 0 ? {
            context_pruning: createPruningTool(janitor, config),
        } : undefined,
    }
}) satisfies Plugin

export default plugin
