/**
 * DCP State Recovery
 *
 * Fixes the fork/inherited-session coverage gap.
 *
 * When opencode forks a session (or a user continues from shared history), the
 * child session inherits the parent's raw messages but NOT the parent's DCP
 * state file (which is keyed by sessionId). As a result the inherited prefix —
 * often dominated by large read/grep/webfetch tool outputs — is never covered
 * by any compression block and keeps entering the request verbatim.
 *
 * opencode does not record a parent link for forks (`parent_id` is only set for
 * subagent sessions) and regenerates message IDs, so we cannot copy the parent
 * state. Instead we replay the session's OWN history: completed `compress`
 * tool parts persist their full input args (topic + content with startId,
 * endId and summary), so the same blocks can be rebuilt deterministically.
 *
 * Deduplication: a compress call is skipped when a block already carries its
 * `compressCallId`, making recovery idempotent across restarts. References that
 * no longer resolve (stale mNNNN after folding) are skipped with a warning and
 * never abort the session.
 */

import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { assignMessageRefs } from "../message-ids"
import { countTokens } from "../token-utils"
import { buildSearchContext } from "../compress/search"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRanges,
    validateSummaryPlaceholders,
} from "../compress/range-utils"
import { resolveMessages } from "../compress/message-utils"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "../compress/protected-content"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "../compress/state"
import { saveSessionState } from "./persistence"
import type { ProtectedContent, SessionState, WithParts } from "./types"
import type {
    CompressMessageToolArgs,
    CompressRangeToolArgs,
    SearchContext,
} from "../compress/types"

export interface CompressCallRecord {
    messageId: string
    callId: string
    input: CompressRangeToolArgs | CompressMessageToolArgs
}

export interface RecoveryResult {
    recovered: number
    skipped: number
    warnings: string[]
}

function isRangeInput(
    input: CompressRangeToolArgs | CompressMessageToolArgs,
): input is CompressRangeToolArgs {
    const content = (input as CompressRangeToolArgs).content
    return Array.isArray(content) && content.some((entry) => typeof entry?.startId === "string")
}

export function collectCompressCallRecords(messages: WithParts[]): CompressCallRecord[] {
    const records: CompressCallRecord[] = []

    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || part.tool !== "compress") {
                continue
            }
            if (part.state?.status !== "completed") {
                continue
            }

            const input = part.state?.input
            if (!input || typeof input !== "object") {
                continue
            }
            if (!Array.isArray((input as { content?: unknown }).content)) {
                continue
            }
            const content = (input as { content: unknown[] }).content
            if (content.length === 0) {
                continue
            }

            records.push({
                messageId: message.info.id,
                callId:
                    typeof part.callID === "string"
                        ? part.callID
                        : `${message.info.id}:${(part as { id?: string }).id ?? "call"}`,
                input: input as unknown as CompressRangeToolArgs | CompressMessageToolArgs,
            })
        }
    }

    return records
}

export function isCompressCallApplied(state: SessionState, callId: string): boolean {
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.compressCallId === callId) {
            return true
        }
    }
    return false
}

interface PreparedRangePlan {
    entry: { startId: string; endId: string; summary: string }
    selection: Parameters<typeof applyCompressionState>[2]
    anchorMessageId: string
    finalSummary: string
    consumedBlockIds: number[]
    protectedContent: ProtectedContent[]
}

async function prepareRangePlans(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    searchContext: SearchContext,
    args: CompressRangeToolArgs,
): Promise<PreparedRangePlan[]> {
    const plans = resolveRanges(args, searchContext, state)
    const prepared: PreparedRangePlan[] = []

    for (const plan of plans) {
        const condense = config.compress.recursiveCondense === true
        const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary, state.idFormat)
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
            state,
            config.compress.protectUserMessages,
        )

        const promptInfo = appendProtectedPromptInfo(
            users.summaryText,
            plan.selection,
            searchContext,
            state,
            config.compress.protectTags,
        )

        const tools = await appendProtectedTools(
            client,
            state,
            config.experimental.allowSubAgents,
            promptInfo.summaryText,
            plan.selection,
            searchContext,
            config.compress.protectedTools,
            config.protectedFilePatterns,
        )

        const completedSummary = appendMissingBlockSummaries(
            tools.summaryText,
            missingBlockIds,
            searchContext.summaryByBlockId,
            injected.consumedBlockIds,
            state.idFormat,
            condense,
        )

        prepared.push({
            entry: plan.entry,
            selection: plan.selection,
            anchorMessageId: plan.anchorMessageId,
            finalSummary: completedSummary.expandedSummary,
            consumedBlockIds: completedSummary.consumedBlockIds,
            protectedContent: [
                ...users.protectedContent,
                ...promptInfo.protectedContent,
                ...tools.protectedContent,
            ],
        })
    }

    return prepared
}

async function replayRangeCall(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    searchContext: SearchContext,
    record: CompressCallRecord,
): Promise<number> {
    const args = record.input as CompressRangeToolArgs
    const prepared = await prepareRangePlans(client, state, logger, config, searchContext, args)

    const runId = allocateRunId(state)
    let created = 0
    for (const plan of prepared) {
        const blockId = allocateBlockId(state)
        const storedSummary = wrapCompressedSummary(blockId, plan.finalSummary, state.idFormat)
        const summaryTokens = countTokens(storedSummary)

        applyCompressionState(
            state,
            {
                topic: args.topic,
                batchTopic: args.topic,
                startId: plan.entry.startId,
                endId: plan.entry.endId,
                mode: "range",
                runId,
                compressMessageId: record.messageId,
                compressCallId: record.callId,
                summaryTokens,
            },
            plan.selection,
            plan.anchorMessageId,
            blockId,
            storedSummary,
            plan.consumedBlockIds,
            plan.protectedContent,
        )
        created++
    }
    return created
}

async function replayMessageCall(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    searchContext: SearchContext,
    record: CompressCallRecord,
): Promise<number> {
    const args = record.input as CompressMessageToolArgs
    const { plans } = resolveMessages(args, searchContext, state, config)

    const runId = allocateRunId(state)
    let created = 0
    for (const plan of plans) {
        const summaryWithPromptInfo = appendProtectedPromptInfo(
            plan.entry.summary,
            plan.selection,
            searchContext,
            state,
            config.compress.protectTags,
        )

        const summaryWithTools = await appendProtectedTools(
            client,
            state,
            config.experimental.allowSubAgents,
            summaryWithPromptInfo.summaryText,
            plan.selection,
            searchContext,
            config.compress.protectedTools,
            config.protectedFilePatterns,
        )

        const blockId = allocateBlockId(state)
        const storedSummary = wrapCompressedSummary(
            blockId,
            summaryWithTools.summaryText,
            state.idFormat,
        )
        const summaryTokens = countTokens(storedSummary)

        applyCompressionState(
            state,
            {
                topic: plan.entry.topic,
                batchTopic: args.topic,
                startId: plan.entry.messageId,
                endId: plan.entry.messageId,
                mode: "message",
                runId,
                compressMessageId: record.messageId,
                compressCallId: record.callId,
                summaryTokens,
            },
            plan.selection,
            plan.anchorMessageId,
            blockId,
            storedSummary,
            [],
            summaryWithTools.protectedContent,
        )
        created++
    }
    return created
}

export async function replayCompletedCompressions(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): Promise<RecoveryResult> {
    const result: RecoveryResult = { recovered: 0, skipped: 0, warnings: [] }

    if (state.isSubAgent) {
        return result
    }

    assignMessageRefs(state, messages)
    const searchContext = buildSearchContext(state, messages)
    const records = collectCompressCallRecords(messages)
    if (records.length === 0) {
        return result
    }

    const pending = records.filter((record) => !isCompressCallApplied(state, record.callId))
    if (pending.length === 0) {
        return result
    }

    logger.info("DCP recovery: replaying compress history", {
        totalRecords: records.length,
        pending: pending.length,
    })

    for (const record of pending) {
        try {
            const created = isRangeInput(record.input)
                ? await replayRangeCall(client, state, logger, config, searchContext, record)
                : await replayMessageCall(client, state, logger, config, searchContext, record)
            result.recovered += created
            logger.debug("DCP recovery: replayed compress call", {
                callId: record.callId,
                blocks: created,
            })
        } catch (error: any) {
            result.skipped++
            const warning = `Skipped replaying compress call ${record.callId}: ${
                error?.message ?? String(error)
            }`
            result.warnings.push(warning)
            logger.warn("DCP recovery: " + warning)
        }
    }

    if (result.recovered > 0) {
        await saveSessionState(state, logger)
        logger.info("DCP recovery: rebuilt compression blocks from history", {
            recovered: result.recovered,
            skipped: result.skipped,
        })
    }

    return result
}
