import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../state/utils"
import { createSyntheticUserMessage, replaceBlockIdsWithBlocked } from "./utils"
import { getLastUserMessage } from "./query"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { formatBlockRef } from "../message-ids"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
    summaryBase?: WithParts,
): void => {
    filterCompressedRanges(state, logger, config, messages, summaryBase)
    pruneToolState(state, messages)
}

/** Tools whose completed output is meaningful enough to keep. */
const OUTPUT_PRESERVED_TOOLS = new Set(["question", "edit", "write"])

const pruneToolState = (state: SessionState, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.tools.has(part.callID)) {
                continue
            }

            if (part.state.status === "completed") {
                if (part.tool === "question") {
                    if (part.state.input?.questions !== undefined) {
                        part.state.input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT
                    }
                } else if (!OUTPUT_PRESERVED_TOOLS.has(part.tool)) {
                    part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
                }
                continue
            }

            if (part.state.status !== "error") {
                continue
            }

            // Prune all string inputs for errored tools
            const input = part.state.input
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
                    }
                }
            }
        }
    }
}

const filterCompressedRanges = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
    summaryBase?: WithParts,
): void => {
    if (
        state.prune.messages.byMessageId.size === 0 &&
        state.prune.messages.activeByAnchorMessageId.size === 0
    ) {
        return
    }

    const result: WithParts[] = []

    for (const msg of messages) {
        const msgId = msg.info.id

        // Check if there's a summary to inject at this anchor point
        const blockId = state.prune.messages.activeByAnchorMessageId.get(msgId)
        const summary =
            blockId !== undefined ? state.prune.messages.blocksById.get(blockId) : undefined
        if (summary) {
            const rawSummaryContent = (summary as { summary?: unknown }).summary
            if (
                summary.active !== true ||
                typeof rawSummaryContent !== "string" ||
                rawSummaryContent.length === 0
            ) {
                logger.warn("Skipping malformed compress summary", {
                    anchorMessageId: msgId,
                    blockId: (summary as { blockId?: unknown }).blockId,
                })
            } else {
                // Find user message for variant and as base for synthetic message
                const msgIndex = messages.indexOf(msg)
                const userMessage = getLastUserMessage(messages, msgIndex) ?? summaryBase

                if (userMessage) {
                    const userInfo = userMessage.info as UserMessage
                    // Persisted summaries can outlive the host's tag format.
                    let renderedSummary = rawSummaryContent
                    if (state.idFormat === "compact") {
                        renderedSummary = renderedSummary.replace(
                            /<dcp-message-id>b(\d+)<\/dcp-message-id>\s*$/i,
                            (_, id) => formatBlockRef(Number(id), "compact"),
                        )
                    }
                    const summaryContent =
                        config.compress.mode === "message"
                            ? replaceBlockIdsWithBlocked(renderedSummary, state.idFormat)
                            : renderedSummary
                    const summarySeed = `${summary.blockId}:${summary.anchorMessageId}`
                    result.push(
                        createSyntheticUserMessage(userMessage, summaryContent, summarySeed),
                    )

                    logger.info("Injected compress summary", {
                        anchorMessageId: msgId,
                        summaryLength: summaryContent.length,
                    })
                } else {
                    logger.warn("No user message found for compress summary", {
                        anchorMessageId: msgId,
                    })
                }
            }
        }

        // Skip messages that are in the prune list
        const pruneEntry = state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
            continue
        }

        // Normal message, include it
        result.push(msg)
    }

    // Replace messages array contents
    messages.length = 0
    messages.push(...result)
}
