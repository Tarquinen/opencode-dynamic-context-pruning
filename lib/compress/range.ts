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
import { generateSummary, selectedSource, redact, MODEL_SELECTION_INSTRUCTIONS } from "./model"

function buildSchema(format: IdFormat, configured: boolean) {
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
                    ...(!configured
                        ? {
                              summary: tool.schema
                                  .string()
                                  .describe(
                                      "Complete technical summary replacing all content in range",
                                  ),
                          }
                        : {}),
                }),
            )
            .describe(
                configured
                    ? "Closed ranges with start/end boundaries; the configured model authors their summaries"
                    : "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()
    const configured = ctx.config.compress.model !== undefined

    return tool({
        description: configured
            ? MODEL_SELECTION_INSTRUCTIONS
            : runtimePrompts.compressRange + rangeFormat(ctx.state.idFormat),
        args: buildSchema(ctx.state.idFormat, configured),
        async execute(args, toolCtx) {
            if (configured && ctx.config.compress.mode !== "range")
                throw new Error(
                    "DCP compress.model currently requires compress.mode='range'; original context retained",
                )
            const input = configured
                ? ({
                      ...args,
                      content: args.content.map((entry) => ({
                          ...entry,
                          summary: "[pending configured model]",
                      })),
                  } as CompressRangeToolArgs)
                : (args as CompressRangeToolArgs)
            validateArgs(input)
            if (configured) toolCtx.abort.throwIfAborted()
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
            if (
                configured &&
                resolvedPlans.some(
                    (plan) =>
                        plan.selection.messageIds.includes(toolCtx.messageID) ||
                        (callId !== undefined && plan.selection.toolIds.includes(callId)),
                )
            )
                throw new Error("DCP model compression cannot include its active compression call")

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
                const source = configured
                    ? selectedSource(plan.selection, searchContext, ctx.state.idFormat)
                    : undefined
                if (configured) {
                    plan.entry.summary = await generateSummary(
                        ctx,
                        input.topic,
                        source!,
                        toolCtx.abort,
                    )
                    const references = parseBlockPlaceholders(
                        plan.entry.summary,
                        ctx.state.idFormat,
                    )
                    if (
                        references.some(
                            (ref) => !plan.selection.requiredBlockIds.includes(ref.blockId),
                        )
                    )
                        throw new Error(
                            "DCP summarizer referenced an unselected block; original context retained",
                        )
                }
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

                // Protected verbatim outputs may contain the same image payload again.
                const finalSummary = source
                    ? (redact(source.media.transform(completedSummary.expandedSummary)) as string)
                    : completedSummary.expandedSummary
                await source?.media.save()

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary,
                    consumedBlockIds: completedSummary.consumedBlockIds,
                })
            }

            if (configured) toolCtx.abort.throwIfAborted()
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
