import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { messageFormat } from "../prompts/extensions/tool"
import { formatMessageRef, type IdFormat } from "../message-ids"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import {
    authoriseCompression,
    finalizeSession,
    prepareSession,
    type NotificationEntry,
} from "./pipeline"
import { exclusive } from "../state"
import { appendProtectedPromptInfo, appendProtectedTools } from "./protected-content"
import {
    allocateBlockId,
    allocateRunId,
    assertPlannedBlockIds,
    peekBlockIds,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressMessageToolArgs } from "./types"

function buildSchema(format: IdFormat) {
    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    messageId: tool.schema
                        .string()
                        .describe(
                            `Raw message ID to compress (e.g. ${formatMessageRef(1, format)})`,
                        ),
                    topic: tool.schema
                        .string()
                        .describe("Short label (3-5 words) for this one message summary"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing that one message"),
                }),
            )
            .describe("Batch of individual message summaries to create in one tool call"),
    }
}

export function createCompressMessageTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressMessage + messageFormat(ctx.state.idFormat),
        args: buildSchema(ctx.state.idFormat),
        async execute(args, toolCtx) {
            const input = args as CompressMessageToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            await authoriseCompression(ctx, toolCtx, `Compress Message: ${input.topic}`)

            return exclusive(ctx.state, async () => {
                const { rawMessages, searchContext } = await prepareSession(ctx, toolCtx)
                // Compression applies only to the state prepared here (see assertPlannedBlockIds).
                const prune = ctx.state.prune.messages
                const { plans, skippedIssues, skippedCount } = await resolveMessages(
                    input,
                    searchContext,
                    ctx.state,
                    ctx.config,
                )

                if (plans.length === 0 && skippedCount > 0) {
                    throw new Error(formatIssues(skippedIssues, skippedCount))
                }

                const notifications: NotificationEntry[] = []

                const preparedPlans: Array<{
                    plan: (typeof plans)[number]
                    summaryWithTools: string
                }> = []

                for (const plan of plans) {
                    const summaryWithPromptInfo = appendProtectedPromptInfo(
                        plan.entry.summary,
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

                    preparedPlans.push({
                        plan,
                        summaryWithTools,
                    })
                }

                // Count every final stored summary before applying anything, so a counting
                // failure leaves no partial compression, counters or notifications behind.
                const plannedBlockIds = peekBlockIds(ctx.state, preparedPlans.length)
                const counted: Array<{ storedSummary: string; summaryTokens: number }> = []
                for (const [index, { summaryWithTools }] of preparedPlans.entries()) {
                    const storedSummary = wrapCompressedSummary(
                        plannedBlockIds[index],
                        summaryWithTools,
                        ctx.state.idFormat,
                    )
                    counted.push({ storedSummary, summaryTokens: await countTokens(storedSummary) })
                }
                assertPlannedBlockIds(ctx.state, prune, plannedBlockIds)

                const runId = allocateRunId(ctx.state)

                for (const [index, { plan, summaryWithTools }] of preparedPlans.entries()) {
                    const blockId = allocateBlockId(ctx.state)
                    const { storedSummary, summaryTokens } = counted[index]

                    applyCompressionState(
                        ctx.state,
                        {
                            topic: plan.entry.topic,
                            batchTopic: input.topic,
                            startId: plan.entry.messageId,
                            endId: plan.entry.messageId,
                            mode: "message",
                            runId,
                            compressMessageId: toolCtx.messageID,
                            compressCallId: callId,
                            summaryTokens,
                        },
                        plan.selection,
                        plan.anchorMessageId,
                        blockId,
                        storedSummary,
                        [],
                    )

                    notifications.push({
                        blockId,
                        runId,
                        summary: summaryWithTools,
                        summaryTokens,
                    })
                }

                await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

                return formatResult(plans.length, skippedIssues, skippedCount)
            })
        },
    })
}
