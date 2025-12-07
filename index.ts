import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { createJanitorContext } from "./lib/core/janitor"
import { checkForUpdates } from "./lib/version-checker"
import { createPluginState } from "./lib/state"
import { installFetchWrapper } from "./lib/fetch-wrapper"
import { createPruningTool } from "./lib/pruning-tool"
import { createEventHandler, createChatParamsHandler } from "./lib/hooks"
import { createToolTracker } from "./lib/fetch-wrapper/tool-tracker"
import { loadPrompt } from "./lib/core/prompt"

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

    const janitorCtx = createJanitorContext(
        ctx.client,
        state,
        logger,
        {
            protectedTools: config.protectedTools,
            model: config.model,
            showModelErrorToasts: config.showModelErrorToasts ?? true,
            strictModelSelection: config.strictModelSelection ?? false,
            pruningSummary: config.pruning_summary,
            workingDirectory: ctx.directory
        }
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
        checkForUpdates(ctx.client, logger, config.showUpdateToasts ?? true).catch(() => { })
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
        event: createEventHandler(ctx.client, janitorCtx, logger, config, toolTracker),
        "chat.params": createChatParamsHandler(ctx.client, state, logger, toolTracker),
        tool: config.strategies.onTool.length > 0 ? {
            prune: createPruningTool({
                client: ctx.client,
                state,
                logger,
                config,
                notificationCtx: janitorCtx.notificationCtx,
                workingDirectory: ctx.directory
            }, toolTracker),
        } : undefined,
    }
}) satisfies Plugin

export default plugin
