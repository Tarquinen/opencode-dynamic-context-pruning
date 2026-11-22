import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import { messageHasCompress } from "../messages/query"
import { countTokens } from "../token-utils"
import { buildSearchContext, resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import { allocateBlockId, allocateRunId, applyCompressionState, wrapCompressedSummary } from "./state"

interface CompressToolResult {
    messageId: string
    callId: string | undefined
    topic: string
    ranges: Array<{
        startId: string
        endId: string
        summary: string
    }>
    messageIndex: number
}

function extractCompressResults(messages: WithParts[]): CompressToolResult[] {
    const results: CompressToolResult[] = []

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i]
        if (!messageHasCompress(message)) {
            continue
        }

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || part.tool !== "compress" || part.state?.status !== "completed") {
                continue
            }

            const input = part.state?.input
            if (!input || !Array.isArray(input.content)) {
                continue
            }

            const ranges: CompressToolResult["ranges"] = []
            for (const entry of input.content) {
                if (typeof entry.startId === "string" && typeof entry.endId === "string" && typeof entry.summary === "string") {
                    ranges.push({
                        startId: entry.startId,
                        endId: entry.endId,
                        summary: entry.summary,
                    })
                }
            }

            if (ranges.length === 0) {
                continue
            }

            results.push({
                messageId: message.info.id,
                callId: typeof part.callID === "string" ? part.callID : undefined,
                topic: typeof input.topic === "string" ? input.topic : "",
                ranges,
                messageIndex: i,
            })
        }
    }

    return results
}

export function hasCompressHistory(messages: WithParts[]): boolean {
    for (const message of messages) {
        if (messageHasCompress(message)) {
            return true
        }
    }
    return false
}

export function reconstructFromHistory(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): number {
    const compressResults = extractCompressResults(messages)
    if (compressResults.length === 0) {
        return 0
    }

    let totalReconstructed = 0
    let skippedResults = 0

    for (const result of compressResults) {
        const searchContext = buildSearchContext(state, messages)
        const runId = allocateRunId(state)

        for (const range of result.ranges) {
            try {
                const { startReference, endReference } = resolveBoundaryIds(
                    searchContext,
                    state,
                    range.startId,
                    range.endId,
                )

                const selection = resolveSelection(searchContext, startReference, endReference)
                const anchorMessageId = resolveAnchorMessageId(startReference)

                const blockId = allocateBlockId(state)
                const storedSummary = wrapCompressedSummary(blockId, range.summary)
                const summaryTokens = countTokens(storedSummary)

                const consumedBlockIds = selection.requiredBlockIds

                applyCompressionState(
                    state,
                    {
                        topic: result.topic,
                        batchTopic: result.topic,
                        startId: range.startId,
                        endId: range.endId,
                        mode: "range",
                        runId,
                        compressMessageId: result.messageId,
                        compressCallId: result.callId,
                        summaryTokens,
                    },
                    selection,
                    anchorMessageId,
                    blockId,
                    storedSummary,
                    consumedBlockIds,
                )

                totalReconstructed++
            } catch (err: any) {
                skippedResults++
                logger.warn("Skipped reconstruction of compress range", {
                    startId: range.startId,
                    endId: range.endId,
                    error: err.message,
                })
            }
        }
    }

    if (totalReconstructed > 0 || skippedResults > 0) {
        logger.info("Reconstructed compression state from history", {
            reconstructed: totalReconstructed,
            skipped: skippedResults,
            totalCompressResults: compressResults.length,
        })
    }

    return totalReconstructed
}
