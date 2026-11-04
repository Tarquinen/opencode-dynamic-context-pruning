import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState } from "../lib/state"
import {
    isSingleBlockRewrap,
    recondenseBlockInPlace,
    stripSelfReferences,
} from "../lib/compress/recondense"
import { wrapCompressedSummary } from "../lib/compress/state"

test("stripSelfReferences removes placeholders that reference the same block", () => {
    const body =
        "Merged (b7) with more; and {block_7} again plus [condensed block b7] tail ### (b7) leftover"
    const cleaned = stripSelfReferences(body, 7)
    assert.equal(cleaned.includes("(b7)"), false)
    assert.equal(cleaned.includes("{block_7}"), false)
    assert.equal(cleaned.includes("[condensed block b7]"), false)
    assert.equal(cleaned.includes("### (b7)"), false)
    assert.match(cleaned, /Merged with more/)
})

test("recondenseBlockInPlace collapses a single-block chain instead of stacking new blocks", () => {
    const state = createSessionState()
    const block = seedActiveBlock(state, 1)
    block.summaryTokens = 5000
    block.summary = wrapCompressedSummary(1, "x".repeat(500))

    const result = recondenseBlockInPlace(state, 1, "much leaner body (b1) no self ref needed")
    assert.equal(result.replaced, true)
    assert.equal(state.prune.messages.blocksById.size, 1)
    const updated = state.prune.messages.blocksById.get(1)
    assert.equal(updated?.active, true)
    assert.doesNotMatch(updated?.summary ?? "", /\(b1\)/)
    assert.match(updated?.summary ?? "", /much leaner body/)
})

function seedActiveBlock(state: ReturnType<typeof createSessionState>, blockId: number) {
    const block = {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 100,
        durationMs: 0,
        topic: `Block ${blockId}`,
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "msg-anchor",
        compressMessageId: "msg-compress",
        compressCallId: `call-${blockId}`,
        includedBlockIds: [] as number[],
        consumedBlockIds: [] as number[],
        parentBlockIds: [] as number[],
        directMessageIds: ["msg-a", "msg-b"],
        directToolIds: ["tool-a"],
        effectiveMessageIds: ["msg-a", "msg-b", "msg-anchor"],
        effectiveToolIds: ["tool-a"],
        createdAt: blockId,
        summary: wrapCompressedSummary(blockId, "existing summary"),
    }
    state.prune.messages.blocksById.set(blockId, block)
    state.prune.messages.activeBlockIds.add(blockId)
    state.prune.messages.byMessageId.set("msg-a", {
        tokenCount: 10,
        allBlockIds: [blockId],
        activeBlockIds: [blockId],
    })
    state.prune.messages.byMessageId.set("msg-b", {
        tokenCount: 10,
        allBlockIds: [blockId],
        activeBlockIds: [blockId],
    })
    state.prune.messages.byMessageId.set("msg-anchor", {
        tokenCount: 10,
        allBlockIds: [blockId],
        activeBlockIds: [blockId],
    })
    state.prune.messages.nextBlockId = blockId + 1
    return block
}

function makeSelection(opts: {
    messageIds: string[]
    toolIds?: string[]
    requiredBlockIds?: number[]
}) {
    return {
        startReference: { kind: "message" as const, rawIndex: 0, messageId: "msg-a" },
        endReference: { kind: "message" as const, rawIndex: 1, messageId: "msg-b" },
        messageIds: opts.messageIds,
        messageTokenById: new Map<string, number>(),
        toolIds: opts.toolIds ?? [],
        requiredBlockIds: opts.requiredBlockIds ?? [],
    }
}

test("isSingleBlockRewrap returns true when the plan only re-wraps one active block with no new content", () => {
    const state = createSessionState()
    seedActiveBlock(state, 1)
    const selection = makeSelection({
        messageIds: ["msg-a", "msg-b", "msg-anchor"],
        toolIds: ["tool-a"],
        requiredBlockIds: [1],
    })
    assert.equal(isSingleBlockRewrap(state, selection), 1)
})

test("isSingleBlockRewrap returns null when plan adds newly-uncovered messages", () => {
    const state = createSessionState()
    seedActiveBlock(state, 1)
    const selection = makeSelection({
        messageIds: ["msg-a", "msg-new"],
        toolIds: ["tool-a"],
        requiredBlockIds: [1],
    })
    assert.equal(isSingleBlockRewrap(state, selection), null)
})

test("isSingleBlockRewrap returns null when required blocks span multiple blocks", () => {
    const state = createSessionState()
    seedActiveBlock(state, 1)
    seedActiveBlock(state, 2)
    state.prune.messages.byMessageId.set("msg-b", {
        tokenCount: 10,
        allBlockIds: [1, 2],
        activeBlockIds: [2],
    })
    const selection = makeSelection({
        messageIds: ["msg-a", "msg-b", "msg-anchor"],
        requiredBlockIds: [1, 2],
    })
    assert.equal(isSingleBlockRewrap(state, selection), null)
})

test("recondenseBlockInPlace rewrites summary and keeps the same block id active", () => {
    const state = createSessionState()
    const block = seedActiveBlock(state, 1)
    const newSummary = "lean recondensed body that is intentionally shorter"
    recondenseBlockInPlace(state, 1, newSummary)

    const updated = state.prune.messages.blocksById.get(1)
    assert.equal(updated?.blockId, 1)
    assert.equal(updated?.active, true)
    assert.match(updated?.summary ?? "", /lean recondensed body/)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.prune.messages.activeBlockIds.size, 1)
    assert.ok((updated?.summaryTokens ?? 0) > 0)
})

test("stripSelfReferences removes compact-format self references", () => {
    const body = "Merged @b7@ with more; plus ### compressed block 7 leftover"
    const cleaned = stripSelfReferences(body, 7)
    assert.equal(cleaned.includes("@b7@"), false)
    assert.equal(cleaned.includes("### compressed block 7"), false)
    assert.match(cleaned, /Merged with more/)
})

test("recondenseBlockInPlace writes a compact-format footer for compact sessions", () => {
    const state = createSessionState("compact")
    const block = seedActiveBlock(state, 1)
    block.summaryTokens = 5000
    block.summary = wrapCompressedSummary(1, "x".repeat(500), "compact")

    const body = "leaner body without self refs"
    const result = recondenseBlockInPlace(state, 1, body)
    assert.equal(result.replaced, true)

    const updated = state.prune.messages.blocksById.get(1)
    assert.equal(updated?.summary, wrapCompressedSummary(1, body, "compact"))
    assert.match(updated?.summary ?? "", /@b1@/)
    assert.doesNotMatch(updated?.summary ?? "", /dcp-message-id/)
})
