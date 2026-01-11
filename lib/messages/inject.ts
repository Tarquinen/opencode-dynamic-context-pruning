import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { loadPrompt } from "../prompts"
import { extractParameterKey, buildToolIdList, createSyntheticUserMessage } from "./utils"
import { getFilePathFromParameters, isProtectedFilePath } from "../protected-file-patterns"
import { getLastUserMessage } from "../shared-utils"

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

    let toolName: string
    if (discardEnabled && extractEnabled) {
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

const buildPrunableToolsList = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): string => {
    const lines: string[] = []
    const toolIdList: string[] = buildToolIdList(state, messages, logger)

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
        lines.push(`${numericId}: ${description}`)
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
    if (!config.tools.discard.enabled && !config.tools.extract.enabled) {
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
        const shouldNudge =
            config.tools.settings.nudgeEnabled &&
            (state.nudgeCounter >= config.tools.settings.nudgeFrequency ||
                state.todoCompletionNudgePending)

        if (shouldNudge) {
            logger.info("Inserting prune nudge message")
            nudgeString = "\n" + getNudgeString(config)

            if (state.todoCompletionNudgePending) {
                state.todoCompletionNudgePending = false
            }
        }

        prunableToolsContent = prunableToolsList + nudgeString
    }

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }
    const variant = state.variant ?? (lastUserMessage.info as UserMessage).variant
    messages.push(createSyntheticUserMessage(lastUserMessage, prunableToolsContent, variant))
}
