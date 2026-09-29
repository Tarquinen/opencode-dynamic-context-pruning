import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import type { CompressionBlock } from "../lib/state"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    validateSummaryPlaceholders,
} from "../lib/compress/range-utils"
import { wrapCompressedSummary } from "../lib/compress/state"
import type { BoundaryReference } from "../lib/compress/types"

function createBlock(blockId: number, body: string): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: `Block ${blockId}`,
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: wrapCompressedSummary(blockId, body),
    }
}

function createMessageBoundary(messageId: string, rawIndex: number): BoundaryReference {
    return {
        kind: "message",
        messageId,
        rawIndex,
    }
}

test("compress range placeholder validation keeps valid placeholders and ignores invalid ones", () => {
    const summaryByBlockId = new Map([
        [1, createBlock(1, "First compressed summary")],
        [2, createBlock(2, "Second compressed summary")],
    ])
    const summary = "Intro (b1) unknown (b9) duplicate (b1) out-of-range (b2) outro"
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    assert.deepEqual(
        parsed.map((placeholder) => placeholder.blockId),
        [1],
    )
    assert.equal(missingBlockIds.length, 0)

    const injected = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
    )

    assert.match(injected.expandedSummary, /First compressed summary/)
    assert.doesNotMatch(injected.expandedSummary, /Second compressed summary/)
    assert.match(injected.expandedSummary, /\(b9\)/)
    assert.match(injected.expandedSummary, /\(b2\)/)
    assert.deepEqual(injected.consumedBlockIds, [1])
})

test("compress range continues by appending required block summaries the model omitted", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Recovered compressed summary")]])
    const summary = "The model forgot to include the prior block."
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    assert.deepEqual(missingBlockIds, [1])

    const injected = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
    )
    const finalSummary = appendMissingBlockSummaries(
        injected.expandedSummary,
        missingBlockIds,
        summaryByBlockId,
        injected.consumedBlockIds,
    )

    assert.match(
        finalSummary.expandedSummary,
        /The following previously compressed summaries were also part of this conversation section:/,
    )
    assert.match(finalSummary.expandedSummary, /### \(b1\)/)
    assert.match(finalSummary.expandedSummary, /Recovered compressed summary/)
    assert.deepEqual(finalSummary.consumedBlockIds, [1])
})
