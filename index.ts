import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { loadPrompt } from "./lib/prompt"
import { createSessionState } from "./lib/state"
import { createDiscardTool, createExtractTool } from "./lib/strategies"
import { createChatMessageTransformHandler, createEventHandler } from "./lib/hooks"

const plugin: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    // Suppress AI SDK warnings
    if (typeof globalThis !== "undefined") {
        ;(globalThis as any).AI_SDK_LOG_WARNINGS = false
    }

    const logger = new Logger(config.debug)
    const state = createSessionState()

    logger.info("DCP initialized", {
        strategies: config.strategies,
    })

    return {
        "experimental.chat.system.transform": async (
            _input: unknown,
            output: { system: string[] },
        ) => {
            const discardEnabled = config.tools.discard.enabled
            const extractEnabled = config.tools.extract.enabled

            let promptName: string
            if (discardEnabled && extractEnabled) {
                promptName = "user/system/system-prompt-both"
            } else if (discardEnabled) {
                promptName = "user/system/system-prompt-discard"
            } else if (extractEnabled) {
                promptName = "user/system/system-prompt-extract"
            } else {
                return
            }

            const syntheticPrompt = loadPrompt(promptName)
            output.system.push(syntheticPrompt)
        },
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            state,
            logger,
            config,
        ),
        tool: {
            ...(config.tools.discard.enabled && {
                discard: createDiscardTool({
                    client: ctx.client,
                    state,
                    logger,
                    config,
                    workingDirectory: ctx.directory,
                }),
            }),
            ...(config.tools.extract.enabled && {
                extract: createExtractTool({
                    client: ctx.client,
                    state,
                    logger,
                    config,
                    workingDirectory: ctx.directory,
                }),
            }),
        },
        config: async (opencodeConfig) => {
            // Add enabled tools to primary_tools by mutating the opencode config
            // This works because config is cached and passed by reference
            const toolsToAdd: string[] = []
            if (config.tools.discard.enabled) toolsToAdd.push("discard")
            if (config.tools.extract.enabled) toolsToAdd.push("extract")

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
                logger.info(
                    `Added ${toolsToAdd.map((t) => `'${t}'`).join(" and ")} to experimental.primary_tools via config mutation`,
                )
            }
        },
        event: createEventHandler(ctx.client, config, state, logger, ctx.directory),
    }
}) satisfies Plugin

export default plugin
