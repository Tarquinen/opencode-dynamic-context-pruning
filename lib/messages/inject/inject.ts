import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import { formatMessageIdTag } from "../../message-ids"
import type { CompressionPriorityMap } from "../priority"
import { compressPermission } from "../../compress-permission"
import {
    getLastUserMessage,
    isIgnoredUserMessage,
    isProtectedUserMessage,
    messageHasCompress,
} from "../query"
import { saveSessionState } from "../../state/persistence"
import {
    appendToTextPart,
    appendToLastTextPart,
    appendToAllToolParts,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudges,
    countMessagesAfterIndex,
    findLastNonIgnoredMessage,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimits,
    isPollOnlyTurn,
} from "./utils"

export const injectCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
    createAnchors = true,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    if (state.manualMode) {
        return
    }

    if (!createAnchors) {
        applyAnchoredNudges(state, config, messages, prompts, compressionPriorities)
        return
    }

    const lastMessage = findLastNonIgnoredMessage(messages)
    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")

    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        state.nudges.contextLimitAnchors.clear()
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        void saveSessionState(state, logger)
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    const { overMaxLimit, overMinLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )

    // Poll-only turns (repeated tool calls without new user input) should not
    // re-trigger the emergency max-context nudge on every iteration.
    const pollOnly = isPollOnlyTurn(state, messages, config.compress.pollCooldown)

    if (!overMinLimit) {
        const hadTurnAnchors = state.nudges.turnNudgeAnchors.size > 0
        const hadIterationAnchors = state.nudges.iterationNudgeAnchors.size > 0

        if (hadTurnAnchors || hadIterationAnchors) {
            state.nudges.turnNudgeAnchors.clear()
            state.nudges.iterationNudgeAnchors.clear()
            anchorsChanged = true
        }
    }

    if (overMaxLimit) {
        if (lastMessage && !pollOnly) {
            const interval = getNudgeFrequency(config)
            const added = addAnchor(
                state.nudges.contextLimitAnchors,
                lastMessage.message.info.id,
                lastMessage.index,
                messages,
                interval,
            )
            if (added) {
                anchorsChanged = true
            }
        }
    } else if (overMinLimit) {
        const isLastMessageUser = lastMessage?.message.info.role === "user"

        if (isLastMessageUser && lastAssistantMessage) {
            const previousSize = state.nudges.turnNudgeAnchors.size
            state.nudges.turnNudgeAnchors.add(lastMessage.message.info.id)
            state.nudges.turnNudgeAnchors.add(lastAssistantMessage.info.id)
            if (state.nudges.turnNudgeAnchors.size !== previousSize) {
                anchorsChanged = true
            }
        }

        const lastUserMessage = getLastUserMessage(messages)
        if (lastUserMessage && lastMessage) {
            const lastUserMessageIndex = messages.findIndex(
                (message) => message.info.id === lastUserMessage.info.id,
            )
            if (lastUserMessageIndex >= 0) {
                const messagesSinceUser = countMessagesAfterIndex(messages, lastUserMessageIndex)
                const iterationThreshold = getIterationNudgeThreshold(config)

                if (
                    lastMessage.index > lastUserMessageIndex &&
                    messagesSinceUser >= iterationThreshold
                ) {
                    const interval = getNudgeFrequency(config)
                    const added = addAnchor(
                        state.nudges.iterationNudgeAnchors,
                        lastMessage.message.info.id,
                        lastMessage.index,
                        messages,
                        interval,
                    )

                    if (added) {
                        anchorsChanged = true
                    }
                }
            }
        }
    }

    applyAnchoredNudges(state, config, messages, prompts, compressionPriorities)

    if (anchorsChanged) {
        void saveSessionState(state, logger)
    }
}

export const injectMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        const messageRef = state.messageIds.byRawId.get(message.info.id)
        if (!messageRef) {
            continue
        }

        const isBlockedMessage = isProtectedUserMessage(config, message)
        const priority =
            config.compress.mode === "message" && !isBlockedMessage
                ? compressionPriorities?.get(message.info.id)?.priority
                : undefined
        const tag = formatMessageIdTag(
            isBlockedMessage ? "BLOCKED" : messageRef,
            priority ? { priority } : undefined,
            state.idFormat,
        )

        if (message.info.role === "user") {
            let injected = false
            for (const part of message.parts) {
                if (part.type === "text") {
                    injected = appendToTextPart(part, tag) || injected
                }
            }

            if (injected) {
                continue
            }

            message.parts.push(createSyntheticTextPart(message, tag))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        if (!hasContent(message)) {
            continue
        }

        if (appendToAllToolParts(message, tag)) {
            continue
        }

        if (appendToLastTextPart(message, tag)) {
            continue
        }

        const syntheticPart = createSyntheticTextPart(message, tag)
        const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
        if (firstToolIndex === -1) {
            message.parts.push(syntheticPart)
        } else {
            message.parts.splice(firstToolIndex, 0, syntheticPart)
        }
    }
}
