import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type CompressionBlock, type SessionState } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { buildCompressedBlockGuidance, buildMessageOccupancyGuidance } from "../lib/prompts/extensions/nudge"
import { getTriggerPrompt, handleManualTriggerCommand } from "../lib/commands/manual"

function buildBlock(blockId: number, summaryTokens: number): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: summaryTokens * 10,
        summaryTokens,
        durationMs: 0,
        mode: "range",
        topic: `topic-${blockId}`,
        startId: `m${blockId}`,
        endId: `m${blockId}`,
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `origin-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: `summary-${blockId}`,
    }
}

function seedBlocks(state: SessionState, sizes: Array<[number, number]>): void {
    for (const [id, tokens] of sizes) {
        state.prune.messages.blocksById.set(id, buildBlock(id, tokens))
        state.prune.messages.activeBlockIds.add(id)
    }
}

test("block guidance lists per-block token cost, total, and the merge hint", () => {
    const state = createSessionState()
    seedBlocks(state, [
        [1, 3200],
        [2, 450],
        [3, 8100],
    ])

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /Active compressed blocks in this session: 3 \(b1, b2, b3\)/)
    assert.match(guidance, /- b3: ~8\.1k tokens/)
    assert.match(guidance, /- b1: ~3\.2k tokens/)
    assert.match(guidance, /- b2: ~450 tokens/)
    assert.match(guidance, /Total held by block summaries: ~11\.8k tokens\./)
    assert.match(guidance, /\(1\) DROP ranges no longer needed/)
    assert.match(guidance, /\(2\) MERGE only content needed/)
    assert.match(guidance, /\(3\) Leave anything uncertain alone\./)
    const dropIndex = guidance.indexOf("(1) DROP")
    const mergeIndex = guidance.indexOf("(2) MERGE")
    assert.ok(dropIndex < mergeIndex, "drop rule must be listed before the merge rule")
    assert.match(guidance, /reference each included block exactly once as `\(bN\)`/)
})

test("block guidance with no active blocks keeps the original shape", () => {
    const state = createSessionState()
    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /Active compressed blocks in this session: 0 \(none\)/)
    assert.doesNotMatch(guidance, /Total held by block summaries/)
    assert.doesNotMatch(guidance, /merging blocks/)
})

test("manual trigger prompt exposes the occupancy guidance", () => {
    const state = createSessionState()
    seedBlocks(state, [[1, 5000]])
    const config = { compress: { mode: "range" } } as PluginConfig

    const prompt = getTriggerPrompt("compress", state, config)

    assert.match(prompt, /dcp_compress/)
    assert.match(prompt, /- b1: ~5\.0k tokens/)
    assert.match(prompt, /\(2\) MERGE only content needed/)
})

test("message occupancy guidance names the largest uncompressed messages", () => {
    const state = createSessionState()
    seedBlocks(state, [[1, 5000]])
    const config = { compress: { mode: "range" } } as PluginConfig

    const big = {
        info: { id: "msg-big", sessionID: "s", role: "assistant", time: { created: 1 } },
        parts: [
            { id: "p1", sessionID: "s", messageID: "msg-big", type: "text", text: "ok" },
            {
                id: "p2",
                sessionID: "s",
                messageID: "msg-big",
                type: "tool",
                tool: "read",
                state: { status: "completed", output: "x".repeat(12000) },
            },
        ],
    }
    const small = {
        info: { id: "msg-small", sessionID: "s", role: "assistant", time: { created: 2 } },
        parts: [{ id: "p3", sessionID: "s", messageID: "msg-small", type: "text", text: "tiny" }],
    }
    state.messageIds.byRawId.set("msg-big", "m0004")
    state.messageIds.byRawId.set("msg-small", "m0005")

    const guidance = buildMessageOccupancyGuidance(state, config, [big, small])

    assert.match(guidance, /Largest uncompressed messages/)
    assert.match(guidance, /- m0004 \(assistant, ~3\.0k tokens, 1 tool output\)/)
    assert.match(guidance, /- m0005 \(assistant, ~1 tokens\)/)
    const bigIndex = guidance.indexOf("m0004")
    const smallIndex = guidance.indexOf("m0005")
    assert.ok(bigIndex < smallIndex, "entries must be sorted by token cost, largest first")
})

test("message occupancy guidance marks protected user messages", () => {
    const state = createSessionState()
    const config = {
        compress: { mode: "message", protectUserMessages: true },
    } as PluginConfig
    const user = {
        info: { id: "msg-user", sessionID: "s", role: "user", time: { created: 1 } },
        parts: [{ id: "p1", sessionID: "s", messageID: "msg-user", type: "text", text: "spec ".repeat(2000) }],
    }
    state.messageIds.byRawId.set("msg-user", "m0002")

    const guidance = buildMessageOccupancyGuidance(state, config, [user])

    assert.match(guidance, /- m0002 \(user, ~2\.5k tokens, protected\)/)
})

test("message occupancy guidance counts reasoning and file parts the model sees", () => {
    const state = createSessionState()
    const config = { compress: { mode: "range" } } as PluginConfig
    const thinking = {
        info: { id: "msg-think", sessionID: "s", role: "assistant", time: { created: 1 } },
        parts: [
            { id: "p1", sessionID: "s", messageID: "msg-think", type: "reasoning", text: "y".repeat(12000) },
        ],
    }
    const media = {
        info: { id: "msg-media", sessionID: "s", role: "user", time: { created: 2 } },
        parts: [
            { id: "p2", sessionID: "s", messageID: "msg-media", type: "file", mime: "image/png", url: "z".repeat(8000) },
        ],
    }
    state.messageIds.byRawId.set("msg-think", "m0002")
    state.messageIds.byRawId.set("msg-media", "m0003")

    const guidance = buildMessageOccupancyGuidance(state, config, [thinking, media])

    assert.match(guidance, /- m0002 \(assistant, ~3\.0k tokens\)/)
    assert.match(guidance, /- m0003 \(user, ~2\.0k tokens\)/)
})

test("message occupancy guidance is empty when nothing has a message ref", () => {
    const state = createSessionState()
    const config = { compress: { mode: "range" } } as PluginConfig
    const tiny = {
        info: { id: "msg-tiny", sessionID: "s", role: "user", time: { created: 1 } },
        parts: [{ id: "p1", sessionID: "s", messageID: "msg-tiny", type: "text", text: "hi" }],
    }

    assert.equal(buildMessageOccupancyGuidance(state, config, [tiny]), "")
})

test("trigger prompt assigns message refs in a fresh process (no seeding)", async () => {
    // Regression: in a fresh process the command path ran before any
    // request-time hook, so state.messageIds.byRawId was empty and the
    // occupancy section was silently dropped. handleManualTriggerCommand
    // must assign refs itself before building the prompt.
    const state = createSessionState()
    seedBlocks(state, [[1, 5000]])
    const config = { compress: { mode: "range" } } as PluginConfig
    const big = {
        info: { id: "msg-big", sessionID: "s", role: "assistant", time: { created: 1 } },
        parts: [
            { id: "p1", sessionID: "s", messageID: "msg-big", type: "text", text: "ok" },
            {
                id: "p2",
                sessionID: "s",
                messageID: "msg-big",
                type: "tool",
                tool: "read",
                state: { status: "completed", output: "x".repeat(12000) },
            },
        ],
    }

    const prompt = await handleManualTriggerCommand(
        { client: null, state, config, logger: null as any, sessionId: "s", messages: [big] } as any,
        "compress",
    )

    assert.match(prompt, /Largest uncompressed messages/)
    assert.match(prompt, /- m000\d+ \(assistant, ~3\.0k tokens, 1 tool output\)/)
})

test("block guidance ignores active ids missing from blocksById", () => {
    const state = createSessionState()
    seedBlocks(state, [[1, 5000]])
    // Simulates a state file where activeBlockIds was restored but the block
    // body is gone (corrupt/older format): listing b9 with "~0 tokens" would
    // mislead the model into targeting a phantom merge.
    state.prune.messages.activeBlockIds.add(9)

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /Active compressed blocks in this session: 1 \(b1\)/)
    assert.doesNotMatch(guidance, /b9/)
})

test("manual trigger prompt carries the merge caveat", () => {
    const state = createSessionState()
    seedBlocks(state, [[1, 5000]])
    const config = { compress: { mode: "range" } } as PluginConfig

    const prompt = getTriggerPrompt("compress", state, config)

    assert.match(prompt, /Merge caveat/)
    assert.match(prompt, /merged blocks can no longer be dropped/)
})
