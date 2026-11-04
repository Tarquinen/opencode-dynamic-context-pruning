import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { rangeFormat } from "../prompts/extensions/tool"
import { formatMessageRef, formatBlockRef, type IdFormat } from "../message-ids"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    isSummaryShrinkViolation,
    parseBlockPlaceholders,
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    validateSummaryPlaceholders,
} from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeToolArgs } from "./types"
import type { ProtectedContent } from "../state"
import { isSingleBlockRewrap, recondenseBlockInPlace } from "./recondense"

function buildSchema(format: IdFormat) {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            `Message or block ID marking the beginning of range (e.g. ${formatMessageRef(1, format)}, ${formatBlockRef(2, format)})`,
                        ),
                    endId: tool.schema
                        .string()
                        .describe(
                            `Message or block ID marking the end of range (e.g. ${formatMessageRef(12, format)}, ${formatBlockRef(5, format)})`,
                        ),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing all content in range"),
                }),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange + rangeFormat(ctx.state.idFormat),
        args: buildSchema(ctx.state.idFormat),
        async execute(args, toolCtx) {
            const input = args as CompressRangeToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${input.topic}`,
            )
            const resolvedPlans = resolveRanges(input, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                selection: (typeof resolvedPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
                protectedContent: ProtectedContent[]
            }> = []
            let totalCompressedMessages = 0

            for (const plan of resolvedPlans) {
                const condense = ctx.config.compress.recursiveCondense === true
                const parsedPlaceholders = parseBlockPlaceholders(
                    plan.entry.summary,
                    ctx.state.idFormat,
                )
                const missingBlockIds = validateSummaryPlaceholders(
                    parsedPlaceholders,
                    plan.selection.requiredBlockIds,
                    plan.selection.startReference,
                    plan.selection.endReference,
                    searchContext.summaryByBlockId,
                )

                const injected = injectBlockPlaceholders(
                    plan.entry.summary,
                    parsedPlaceholders,
                    searchContext.summaryByBlockId,
                    plan.selection.startReference,
                    plan.selection.endReference,
                    condense,
                )

                const users = appendProtectedUserMessages(
                    injected.expandedSummary,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                const promptInfo = appendProtectedPromptInfo(
                    users.summaryText,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectTags,
                )

                const tools = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    promptInfo.summaryText,
                    plan.selection,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                const completedSummary = appendMissingBlockSummaries(
                    tools.summaryText,
                    missingBlockIds,
                    searchContext.summaryByBlockId,
                    injected.consumedBlockIds,
                    ctx.state.idFormat,
                    condense,
                )

                const protectedContent = [
                    ...users.protectedContent,
                    ...promptInfo.protectedContent,
                    ...tools.protectedContent,
                ]

                if (ctx.config.compress.enforceSummaryShrink) {
                    let compressedTokens = 0
                    for (const tokenCount of plan.selection.messageTokenById.values()) {
                        compressedTokens += tokenCount
                    }
                    for (const consumedBlockId of completedSummary.consumedBlockIds) {
                        const consumedBlock = searchContext.summaryByBlockId.get(consumedBlockId)
                        if (consumedBlock) {
                            compressedTokens += consumedBlock.summaryTokens
                        }
                    }
                    const summaryTokens = countTokens(completedSummary.expandedSummary)
                    if (isSummaryShrinkViolation(summaryTokens, compressedTokens)) {
                        throw new Error(
                            `Compression rejected: summary (~${summaryTokens} tokens) is not smaller than the content it replaces (~${compressedTokens} tokens). ` +
                                "Write a much more condensed summary - it must be significantly smaller than what it replaces. " +
                                "Prefer merging existing compressed blocks into one parent instead of restating their full content.",
                        )
                    }
                }

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: completedSummary.expandedSummary,
                    consumedBlockIds: completedSummary.consumedBlockIds,
                    protectedContent,
                })
            }

            const runId = allocateRunId(ctx.state)
            let recondensedCount = 0
            let skippedRewrapCount = 0

            for (const preparedPlan of preparedPlans) {
                const rewrapBlockId = isSingleBlockRewrap(ctx.state, preparedPlan.selection)
                if (rewrapBlockId !== null) {
                    const result = recondenseBlockInPlace(
                        ctx.state,
                        rewrapBlockId,
                        preparedPlan.entry.summary,
                    )
                    if (result.replaced) {
                        recondensedCount++
                    } else {
                        skippedRewrapCount++
                    }
                    continue
                }

                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(
                    blockId,
                    preparedPlan.finalSummary,
                    ctx.state.idFormat,
                )
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: input.topic,
                        batchTopic: input.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    preparedPlan.selection,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                    preparedPlan.protectedContent,
                )

                totalCompressedMessages += applied.messageIds.length

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            if (recondensedCount > 0) {
                ctx.state.lastDcpCompression = Date.now()
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            const resultParts: string[] = []
            if (totalCompressedMessages > 0 || notifications.length > 0) {
                resultParts.push(
                    `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`,
                )
            }
            if (recondensedCount > 0) {
                resultParts.push(
                    `Recondensed ${recondensedCount} existing block(s) in place (no new block).`,
                )
            }
            if (skippedRewrapCount > 0) {
                resultParts.push(
                    `Skipped ${skippedRewrapCount} compression(s) that only re-wrapped an already-compressed block without shrinking it.`,
                )
            }
            if (resultParts.length === 0) {
                resultParts.push(
                    "No compression was performed: the requested range would only re-wrap already-compressed content without adding new coverage or shrinking the summary.",
                )
            }
            return resultParts.join("\n")
        },
    })
}
