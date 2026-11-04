import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock } from "../lib/state"
import {
    getBlockProtectedContent,
    parseProtectedContentFromSummary,
    renderProtectedContent,
} from "../lib/compress/protected-content"
import {
    injectBlockPlaceholders,
    appendMissingBlockSummaries,
    parseBlockPlaceholders,
    validateSummaryPlaceholders,
} from "../lib/compress/range-utils"
import { wrapCompressedSummary } from "../lib/compress/state"
import type { BoundaryReference } from "../lib/compress/types"

function createBlock(
    blockId: number,
    body: string,
    protectedContent?: CompressionBlock["protectedContent"],
): CompressionBlock {
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
        protectedContent,
    }
}

function createMessageBoundary(messageId: string, rawIndex: number): BoundaryReference {
    return {
        kind: "message",
        messageId,
        rawIndex,
    }
}

test("parseProtectedContentFromSummary extracts explicit protected headings only", () => {
    const summary = [
        "Normal body",
        "",
        "The following protected tools were used in this conversation as well:",
        "### Tool: read",
        "<read output>",
        "### Tool: task",
        "<subagent output>",
        "",
        "The following previously compressed summaries were also part of this conversation section:",
        "### (b3)",
        "nested old summary that must never be copied",
    ].join("\n")

    const entries = parseProtectedContentFromSummary(summary)
    assert.equal(entries.length, 2)
    assert.deepEqual(
        entries.map((entry) => entry.kind),
        ["tool", "tool"],
    )
    assert.match(entries[0]?.text || "", /### Tool: read/)
    assert.match(entries[0]?.text || "", /<read output>/)
    assert.doesNotMatch(entries[0]?.text || "", /previously compressed/)
    assert.doesNotMatch(entries[0]?.text || "", /nested old summary/)
})

test("parseProtectedContentFromSummary captures user and prompt headings in order", () => {
    const summary = [
        "Body",
        "",
        "The following user messages were sent in this conversation verbatim:",
        "user instruction A",
        "",
        "The following protected prompt information was included in this conversation verbatim:",
        "<protect>token</protect>",
        "",
        "The following protected tools were used in this conversation as well:",
        "### Tool: bash",
        "<bash output>",
    ].join("\n")

    const entries = parseProtectedContentFromSummary(summary)
    assert.equal(entries.length, 3)
    assert.equal(entries[0]?.kind, "user")
    assert.equal(entries[1]?.kind, "prompt")
    assert.equal(entries[2]?.kind, "tool")
    assert.match(entries[1]?.text || "", /token/)
})

test("renderProtectedContent reconstructs sections and dedupes", () => {
    const entries = [
        { kind: "tool" as const, text: "### Tool: read\n<output>" },
        { kind: "tool" as const, text: "### Tool: read\n<output>" },
        { kind: "user" as const, text: "instruction" },
    ]
    const rendered = renderProtectedContent(entries)
    assert.match(rendered, /The following protected tools were used in this conversation as well:/)
    assert.match(rendered, /### Tool: read/)
    assert.match(rendered, /The following user messages were sent in this conversation verbatim:/)
    assert.match(rendered, /instruction/)
    // dedup: tool entry appears once
    assert.equal(rendered.match(/### Tool: read/g)?.length, 1)
})

test("getBlockProtectedContent prefers structured field over summary parsing", () => {
    const block = createBlock(1, "Body", [{ kind: "tool", text: "### Tool: read\n<out>" }])
    const entries = getBlockProtectedContent(block)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.kind, "tool")
})

test("getBlockProtectedContent migrates legacy blocks from summary (no previously-compressed tail)", () => {
    const legacySummary = [
        "Body",
        "",
        "The following protected tools were used in this conversation as well:",
        "### Tool: grep",
        "<grep output>",
        "",
        "The following previously compressed summaries were also part of this conversation section:",
        "### (b2)",
        "old nested summary",
    ].join("\n")
    const block = createBlock(1, "Body")
    block.summary = wrapCompressedSummary(1, legacySummary)

    const entries = getBlockProtectedContent(block)
    assert.equal(entries.length, 1)
    assert.match(entries[0]?.text || "", /### Tool: grep/)
    assert.doesNotMatch(entries[0]?.text || "", /old nested summary/)
})

test("condense merge never copies the previously-compressed-summaries tail", () => {
    const childSummary = [
        "Child normal body",
        "",
        "The following protected tools were used in this conversation as well:",
        "### Tool: webfetch",
        "<webfetch output>",
        "",
        "The following previously compressed summaries were also part of this conversation section:",
        "### (b2)",
        "a huge nested tail that previously bloated the parent",
    ].join("\n")

    const child = createBlock(1, "Child body")
    child.summary = wrapCompressedSummary(1, childSummary)

    const summaryByBlockId = new Map([[1, child]])
    const summary = "Parent (b1) end."
    const parsed = parseBlockPlaceholders(summary)
    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    const injected = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        true,
    )

    assert.match(injected.expandedSummary, /\[condensed block b1\]/)
    assert.match(injected.expandedSummary, /### Tool: webfetch/)
    assert.doesNotMatch(injected.expandedSummary, /huge nested tail/)
    assert.doesNotMatch(injected.expandedSummary, /previously compressed summaries/)
    assert.equal(injected.protectedContent.length, 1)
    assert.equal(injected.protectedContent[0]?.kind, "tool")

    const finalSummary = appendMissingBlockSummaries(
        injected.expandedSummary,
        missingBlockIds,
        summaryByBlockId,
        injected.consumedBlockIds,
        true,
    )
    // Block already consumed via placeholder: no extra section appended, and
    // the previously-compressed tail is never copied forward.
    assert.doesNotMatch(finalSummary.expandedSummary, /huge nested tail/)
    assert.doesNotMatch(finalSummary.expandedSummary, /previously compressed summaries/)
    assert.equal(finalSummary.consumedBlockIds.length, 1)
})

test("non-condense merge keeps protected content for future structured merges", () => {
    const child = createBlock(1, "Child body", [{ kind: "tool", text: "### Tool: read\n<out>" }])
    const summaryByBlockId = new Map([[1, child]])
    const summary = "Parent (b1) end."
    const parsed = parseBlockPlaceholders(summary)

    const injected = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        false,
    )

    assert.equal(injected.protectedContent.length, 1)
    assert.equal(injected.protectedContent[0]?.kind, "tool")
})
