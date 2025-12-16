import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { getLastAssistantMessage, extractParameterKey, buildToolIdList } from "./utils"
import { loadPrompt } from "../prompt"

const PRUNED_TOOL_OUTPUT_REPLACEMENT = '[Output removed to save context - information superseded or no longer needed]'
const NUDGE_STRING = loadPrompt("nudge")

const buildPrunableToolsList = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): string => {
    const lines: string[] = []
    const toolIdList: string[] = buildToolIdList(messages)

    state.toolParameters.forEach((toolParameterEntry, toolCallId) => {
        if (state.prune.toolIds.includes(toolCallId)) {
            return
        }
        if (config.strategies.pruneTool.protectedTools.includes(toolParameterEntry.tool)) {
            return
        }
        if (toolParameterEntry.compacted) {
            return
        }
        const numericId = toolIdList.indexOf(toolCallId)
        const paramKey = extractParameterKey(toolParameterEntry.tool, toolParameterEntry.parameters)
        const description = paramKey ? `${toolParameterEntry.tool}, ${paramKey}` : toolParameterEntry.tool
        lines.push(`${numericId}: ${description}`)
        logger.debug(`Prunable tool found - ID: ${numericId}, Tool: ${toolParameterEntry.tool}, Call ID: ${toolCallId}`)
    })

    if (lines.length === 0) {
        return ""
    }

    return `<prunable-tools>\nThe following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before discarding valuable tool outputs. Keep the context free of noise.\n${lines.join('\n')}\n</prunable-tools>`
}

export const insertPruneToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[]
): void => {
    if (!config.strategies.pruneTool.enabled) {
        return
    }

    const lastAssistantMessage = getLastAssistantMessage(messages)
    if (!lastAssistantMessage) {
        logger.debug("No assistant message found, skipping prune context injection")
        return
    }

    const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
    if (!prunableToolsList) {
        return
    }

    let nudgeString = ""
    if (state.nudgeCounter >= config.strategies.pruneTool.nudge.frequency) {
        logger.info("Inserting prune nudge message")
        nudgeString = "\n" + NUDGE_STRING
    }

    // Inject as a new text part appended to the most recent assistant message.
    // This preserves thinking blocks (which must be at the start) and works
    // during tool use loops where the last message may be a user tool_result.
    const syntheticPart = {
        id: "prt_dcp_prunable_" + Date.now(),
        sessionID: lastAssistantMessage.info.sessionID,
        messageID: lastAssistantMessage.info.id,
        type: "text",
        text: prunableToolsList + nudgeString,
        synthetic: true,
    } as any

    lastAssistantMessage.parts.push(syntheticPart)
}

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[]
): void => {
    pruneToolOutputs(state, logger, messages)
    // more prune methods coming here
}

const pruneToolOutputs = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[]
): void => {
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type !== 'tool') {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.state.status === 'completed') {
                part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
            }
            // if (part.state.status === 'error') {
            //     part.state.error = PRUNED_TOOL_OUTPUT_REPLACEMENT
            // }
        }
    }
}
