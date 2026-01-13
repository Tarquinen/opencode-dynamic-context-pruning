import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { loadPrompt } from "../prompts"
import {
    extractParameterKey,
    buildToolIdList,
    createSyntheticAssistantMessageWithToolPart,
    createSyntheticUserMessage,
} from "./utils"
import { getFilePathFromParameters, isProtectedFilePath } from "../protected-file-patterns"
import { getLastUserMessage } from "../shared-utils"
import { turnsUntilAutoPrune, shouldShowAutoPruneWarning } from "../strategies/auto-prune"

const getNudgeString = (config: PluginConfig): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled

    if (discardEnabled && extractEnabled) {
        return loadPrompt(`user/nudge/nudge-both`)
    } else if (discardEnabled) {
        return loadPrompt(`user/nudge/nudge-discard`)
    } else if (extractEnabled) {
        return loadPrompt(`user/nudge/nudge-extract`)
    }
    return ""
}

const wrapPrunableTools = (content: string): string => `<prunable-tools>
The following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before discarding valuable tool inputs or outputs. Consolidate your prunes for efficiency; it is rarely worth pruning a single tiny tool output. Keep the context free of noise.
${content}
</prunable-tools>`

const getCooldownMessage = (config: PluginConfig): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled
    const pinEnabled = config.tools.pin.enabled

    let toolName: string
    if (pinEnabled) {
        toolName = extractEnabled ? "pin or extract tools" : "pin tool"
    } else if (discardEnabled && extractEnabled) {
        toolName = "discard or extract tools"
    } else if (discardEnabled) {
        toolName = "discard tool"
    } else {
        toolName = "extract tool"
    }

    return `<prunable-tools>
Context management was just performed. Do not use the ${toolName} again. A fresh list will be available after your next tool use.
</prunable-tools>`
}

const getAutoPruneWarningMessage = (state: SessionState, config: PluginConfig): string => {
    const turns = turnsUntilAutoPrune(state, config)
    const pinnedCount = state.pins.size

    return `<auto-prune-warning>
Auto-prune in ${turns} turn(s). All unpinned tool outputs will be discarded.
Currently ${pinnedCount} tool(s) pinned. Use the \`pin\` tool NOW to preserve any context you need.
</auto-prune-warning>`
}

const buildPrunableToolsList = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): string => {
    const lines: string[] = []
    const toolIdList: string[] = buildToolIdList(state, messages, logger)
    const pinningModeEnabled = config.tools.pinningMode.enabled

    state.toolParameters.forEach((toolParameterEntry, toolCallId) => {
        if (state.prune.toolIds.includes(toolCallId)) {
            return
        }

        const allProtectedTools = config.tools.settings.protectedTools
        if (allProtectedTools.includes(toolParameterEntry.tool)) {
            return
        }

        const filePath = getFilePathFromParameters(toolParameterEntry.parameters)
        if (isProtectedFilePath(filePath, config.protectedFilePatterns)) {
            return
        }

        const numericId = toolIdList.indexOf(toolCallId)
        if (numericId === -1) {
            logger.warn(`Tool in cache but not in toolIdList - possible stale entry`, {
                toolCallId,
                tool: toolParameterEntry.tool,
            })
            return
        }
        const paramKey = extractParameterKey(toolParameterEntry.tool, toolParameterEntry.parameters)
        const description = paramKey
            ? `${toolParameterEntry.tool}, ${paramKey}`
            : toolParameterEntry.tool

        // Show pin status in pinning mode
        let line = `${numericId}: ${description}`
        if (pinningModeEnabled) {
            const pin = state.pins.get(toolCallId)
            if (pin) {
                const turnsRemaining = pin.expiresAtTurn - state.currentTurn
                line += ` [PINNED, expires in ${turnsRemaining} turn(s)]`
            }
        }

        lines.push(line)
        logger.debug(
            `Prunable tool found - ID: ${numericId}, Tool: ${toolParameterEntry.tool}, Call ID: ${toolCallId}`,
        )
    })

    if (lines.length === 0) {
        return ""
    }

    return wrapPrunableTools(lines.join("\n"))
}

export const insertPruneToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    const pinEnabled = config.tools.pin.enabled
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled

    // Need at least one pruning tool enabled
    if (!pinEnabled && !discardEnabled && !extractEnabled) {
        return
    }

    let prunableToolsContent: string

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        prunableToolsContent = getCooldownMessage(config)
    } else {
        const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
        if (!prunableToolsList) {
            return
        }

        logger.debug("prunable-tools: \n" + prunableToolsList)

        let nudgeString = ""
        // Only show nudge in non-pinning mode
        if (
            !config.tools.pinningMode.enabled &&
            config.tools.settings.nudgeEnabled &&
            state.nudgeCounter >= config.tools.settings.nudgeFrequency
        ) {
            logger.info("Inserting prune nudge message")
            nudgeString = "\n" + getNudgeString(config)
        }

        // Add auto-prune warning if approaching prune cycle
        let warningString = ""
        if (shouldShowAutoPruneWarning(state, config)) {
            logger.info("Inserting auto-prune warning message")
            warningString = "\n" + getAutoPruneWarningMessage(state, config)
        }

        prunableToolsContent = prunableToolsList + nudgeString + warningString
    }

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const userInfo = lastUserMessage.info as UserMessage
    const providerID = userInfo.model.providerID
    const isGitHubCopilot =
        providerID === "github-copilot" || providerID === "github-copilot-enterprise"

    logger.info("Injecting prunable-tools list", {
        providerID,
        isGitHubCopilot,
        injectionType: isGitHubCopilot ? "assistant-with-tool-part" : "user-message",
    })

    const variant = state.variant ?? (lastUserMessage.info as UserMessage).variant
    if (isGitHubCopilot) {
        messages.push(
            createSyntheticAssistantMessageWithToolPart(
                lastUserMessage,
                prunableToolsContent,
                variant,
            ),
        )
    } else {
        messages.push(createSyntheticUserMessage(lastUserMessage, prunableToolsContent, variant))
    }
}
