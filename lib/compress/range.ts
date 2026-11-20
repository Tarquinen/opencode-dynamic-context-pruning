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
    normalizeRangeArgs,
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
            const input = normalizeRangeArgs(args)
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
            }> = []
            let totalCompressedMessages = 0

            for (const plan of resolvedPlans) {
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
                )

                const summaryWithUsers = appendProtectedUserMessages(
                    injected.expandedSummary,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    summaryWithUsers,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectTags,
                )

                const summaryWithTools = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    summaryWithPromptInfo,
                    plan.selection,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                const completedSummary = appendMissingBlockSummaries(
                    summaryWithTools,
                    missingBlockIds,
                    searchContext.summaryByBlockId,
                    injected.consumedBlockIds,
                    ctx.state.idFormat,
                )

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: completedSummary.expandedSummary,
                    consumedBlockIds: completedSummary.consumedBlockIds,
                })
            }

            const runId = allocateRunId(ctx.state)

            for (const preparedPlan of preparedPlans) {
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
                )

                totalCompressedMessages += applied.messageIds.length

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
