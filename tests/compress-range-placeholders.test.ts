import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock } from "../lib/state"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    isSummaryShrinkViolation,
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

function createCompressedBlockBoundary(blockId: number, rawIndex: number): BoundaryReference {
    return {
        kind: "compressed-block",
        blockId,
        rawIndex,
    }
}

function createBlockWithProtected(
    blockId: number,
    body: string,
    protectedBody: string,
): CompressionBlock {
    const block = createBlock(blockId, body)
    block.summary = wrapCompressedSummary(blockId, `${body}\n\n${protectedBody}`)
    return block
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

test("condense mode replaces placeholders with block refs and preserves protected sections", () => {
    const summaryByBlockId = new Map([
        [
            1,
            createBlockWithProtected(
                1,
                "First compressed body",
                "The following protected tools were used in this conversation as well:\n### Tool: task\n<subagent output>",
            ),
        ],
        [2, createBlock(2, "Second compressed body")],
    ])
    const summary = "Merged (b1) and (b2) into one parent."
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1, 2],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    assert.deepEqual(missingBlockIds.length, 0)

    const injected = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        true,
    )

    assert.match(injected.expandedSummary, /\[condensed block b1\]/)
    assert.match(injected.expandedSummary, /\[condensed block b2\]/)
    assert.doesNotMatch(injected.expandedSummary, /First compressed body/)
    assert.doesNotMatch(injected.expandedSummary, /Second compressed body/)
    assert.match(
        injected.expandedSummary,
        /The following protected tools were used in this conversation as well:/,
    )
    assert.match(injected.expandedSummary, /<subagent output>/)
    assert.deepEqual(injected.consumedBlockIds, [1, 2])
})

test("condense mode does not expand full body for boundary blocks", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Boundary compressed body")]])
    const summary = "Parent summary without placeholder."
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1],
        createCompressedBlockBoundary(1, 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    assert.deepEqual(missingBlockIds, [])

    const injected = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createCompressedBlockBoundary(1, 0),
        createMessageBoundary("msg-b", 1),
        true,
    )

    assert.match(injected.expandedSummary, /\[condensed block b1\]/)
    assert.doesNotMatch(injected.expandedSummary, /Boundary compressed body/)
    assert.deepEqual(injected.consumedBlockIds, [1])
})

test("condense mode appends condensed refs for omitted required blocks", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Omitted compressed body")]])
    const summary = "The model forgot the prior block."
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
        true,
    )
    const finalSummary = appendMissingBlockSummaries(
        injected.expandedSummary,
        missingBlockIds,
        summaryByBlockId,
        injected.consumedBlockIds,
        "xml",
        true,
    )

    assert.match(finalSummary.expandedSummary, /### \(b1\)/)
    assert.match(finalSummary.expandedSummary, /\[condensed block b1\]/)
    assert.doesNotMatch(finalSummary.expandedSummary, /Omitted compressed body/)
    assert.deepEqual(finalSummary.consumedBlockIds, [1])
})

test("isSummaryShrinkViolation rejects summaries no smaller than replaced content", () => {
    assert.equal(isSummaryShrinkViolation(453, 121), true)
    assert.equal(isSummaryShrinkViolation(17500, 6700), true)
    assert.equal(isSummaryShrinkViolation(15300, 88800), false)
    assert.equal(isSummaryShrinkViolation(500, 500), true)
    assert.equal(isSummaryShrinkViolation(0, 0), false)
    assert.equal(isSummaryShrinkViolation(800, 0), false)
})
