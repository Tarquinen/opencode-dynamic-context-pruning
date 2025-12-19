import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { loadPrompt } from "../prompt"
import { extractParameterKey, buildToolIdList } from "./utils"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"
import { UserMessage } from "@opencode-ai/sdk"

const PRUNED_TOOL_INPUT_REPLACEMENT = '[Input removed to save context]'
const PRUNED_TOOL_OUTPUT_REPLACEMENT = '[Output removed to save context - information superseded or no longer needed]'
const NUDGE_STRING = loadPrompt("nudge")

const wrapPrunableTools = (content: string): string => `<prunable-tools>
The following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before discarding valuable tool inputs or outputs. Consolidate your prunes for efficiency; it is rarely worth pruning a single tiny tool output. Keep the context free of noise.
${content}
</prunable-tools>`
const PRUNABLE_TOOLS_COOLDOWN = `<prunable-tools>
Pruning was just performed. Do not use the prune tool again. A fresh list will be available after your next tool use.
</prunable-tools>`

const SYNTHETIC_MESSAGE_ID = "msg_01234567890123456789012345"
const SYNTHETIC_PART_ID = "prt_01234567890123456789012345"

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
        if (config.strategies.pruneTool.protectedTools.includes(toolParameterEntry.tool)) {
            return
        }
        const numericId = toolIdList.indexOf(toolCallId)
        if (numericId === -1) {
            logger.warn(`Tool in cache but not in toolIdList - possible stale entry`, { toolCallId, tool: toolParameterEntry.tool })
            return
        }
        const paramKey = extractParameterKey(toolParameterEntry.tool, toolParameterEntry.parameters)
        const description = paramKey ? `${toolParameterEntry.tool}, ${paramKey}` : toolParameterEntry.tool
        lines.push(`${numericId}: ${description}`)
        logger.debug(`Prunable tool found - ID: ${numericId}, Tool: ${toolParameterEntry.tool}, Call ID: ${toolCallId}`)
    })

    if (lines.length === 0) {
        return ""
    }

    return wrapPrunableTools(lines.join('\n'))
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

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    let prunableToolsContent: string

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        prunableToolsContent = PRUNABLE_TOOLS_COOLDOWN
    } else {
        const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
        if (!prunableToolsList) {
            return
        }

        logger.debug("prunable-tools: \n" + prunableToolsList)

        let nudgeString = ""
        if (state.nudgeCounter >= config.strategies.pruneTool.nudge.frequency) {
            logger.info("Inserting prune nudge message")
            nudgeString = "\n" + NUDGE_STRING
        }

        prunableToolsContent = prunableToolsList + nudgeString
    }

    const userMessage: WithParts = {
        info: {
            id: SYNTHETIC_MESSAGE_ID,
            sessionID: lastUserMessage.info.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: (lastUserMessage.info as UserMessage).agent || "build",
            model: {
                providerID: (lastUserMessage.info as UserMessage).model.providerID,
                modelID: (lastUserMessage.info as UserMessage).model.modelID
            }
        },
        parts: [
            {
                id: SYNTHETIC_PART_ID,
                sessionID: lastUserMessage.info.sessionID,
                messageID: SYNTHETIC_MESSAGE_ID,
                type: "text",
                text: prunableToolsContent,
            }
        ]
    }

    messages.push(userMessage)
}

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[]
): void => {
    pruneToolOutputs(state, logger, messages)
    pruneToolInputs(state, logger, messages)
}

const pruneToolOutputs = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[]
): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== 'tool') {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            // Skip write and edit tools - their inputs are pruned instead
            if (part.tool === 'write' || part.tool === 'edit') {
                continue
            }
            if (part.state.status === 'completed') {
                part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
            }
        }
    }
}

const pruneToolInputs = (
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
            // Only prune inputs for write and edit tools
            if (part.tool !== 'write' && part.tool !== 'edit') {
                continue
            }
            // Don't prune yet if tool is still pending or running
            if (part.state.status === "pending" || part.state.status === "running") {
                continue
            }

            if (part.state.input?.content !== undefined) {
                part.state.input.content = PRUNED_TOOL_INPUT_REPLACEMENT
            }
        }
    }
}
