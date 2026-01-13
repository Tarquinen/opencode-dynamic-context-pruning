import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { loadPrompt } from "./lib/prompts"
import { createSessionState } from "./lib/state"
import { createDiscardTool, createExtractTool, createPinTool } from "./lib/strategies"
import { createChatMessageTransformHandler } from "./lib/hooks"

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
            const systemText = output.system.join("\n")
            const internalAgentSignatures = [
                "You are a title generator",
                "You are a helpful AI assistant tasked with summarizing conversations",
                "Summarize what was done in this conversation",
            ]
            if (internalAgentSignatures.some((sig) => systemText.includes(sig))) {
                logger.info("Skipping DCP system prompt injection for internal agent")
                return
            }

            const discardEnabled = config.tools.discard.enabled
            const extractEnabled = config.tools.extract.enabled
            const pinEnabled = config.tools.pin.enabled
            const pinningModeEnabled = config.tools.pinningMode.enabled

            let promptName: string
            if (pinningModeEnabled || pinEnabled) {
                // Pinning mode: use pin prompt (with optional extract)
                promptName = extractEnabled
                    ? "user/system/system-prompt-pin-extract"
                    : "user/system/system-prompt-pin"
            } else if (discardEnabled && extractEnabled) {
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
            ctx.directory,
        ),
        "chat.message": async (
            input: {
                sessionID: string
                agent?: string
                model?: { providerID: string; modelID: string }
                messageID?: string
                variant?: string
            },
            _output: any,
        ) => {
            // Cache variant from real user messages (not synthetic)
            // This avoids scanning all messages to find variant
            state.variant = input.variant
            logger.debug("Cached variant from chat.message hook", { variant: input.variant })
        },
        tool: {
            // Discard tool only available in non-pinning mode
            ...(!config.tools.pinningMode.enabled &&
                config.tools.discard.enabled && {
                    discard: createDiscardTool({
                        client: ctx.client,
                        state,
                        logger,
                        config,
                        workingDirectory: ctx.directory,
                    }),
                }),
            // Extract tool available in both modes
            ...(config.tools.extract.enabled && {
                extract: createExtractTool({
                    client: ctx.client,
                    state,
                    logger,
                    config,
                    workingDirectory: ctx.directory,
                }),
            }),
            // Pin tool only available in pinning mode
            ...(config.tools.pin.enabled && {
                pin: createPinTool({
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
            // In pinning mode, add pin instead of discard
            if (config.tools.pinningMode.enabled) {
                if (config.tools.pin.enabled) toolsToAdd.push("pin")
            } else {
                if (config.tools.discard.enabled) toolsToAdd.push("discard")
            }
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
    }
}) satisfies Plugin

export default plugin
