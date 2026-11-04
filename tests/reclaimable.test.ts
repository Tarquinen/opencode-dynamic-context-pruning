import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import {
    findReclaimableRegions,
    renderReclaimableGuidance,
} from "../lib/messages/inject/reclaimable"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"

function buildMessage(id: string, role: "user" | "assistant", text: string, ignored = false) {
    return {
        info: {
            id,
            role,
            sessionID: "ses-reclaim",
            agent: "assistant",
            ...(role === "user"
                ? { model: { providerID: "anthropic", modelID: "claude-test" } }
                : {}),
            time: { created: 1 },
        } as WithParts["info"],
        parts: ignored
            ? [
                  {
                      id: `part-${id}`,
                      messageID: id,
                      sessionID: "ses-reclaim",
                      type: "text" as const,
                      text,
                      ignored: true,
                  },
              ]
            : [
                  {
                      id: `part-${id}`,
                      messageID: id,
                      sessionID: "ses-reclaim",
                      type: "text" as const,
                      text,
                  },
              ],
    }
}

function buildSyntheticSummary(id: string, text: string) {
    return {
        info: {
            id,
            role: "user" as const,
            sessionID: "ses-reclaim",
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            {
                id: `part-${id}`,
                messageID: id,
                sessionID: "ses-reclaim",
                type: "text" as const,
                text,
            },
        ],
    }
}

function assignRefs(state: ReturnType<typeof createSessionState>, messages: WithParts[]) {
    let n = 1
    for (const m of messages) {
        if (m.info.id.startsWith("msg_dcp_summary_")) continue
        const ref = `m${String(n).padStart(4, "0")}`
        state.messageIds.byRawId.set(m.info.id, ref)
        state.messageIds.byRef.set(ref, m.info.id)
        n++
    }
}

function addActiveBlock(
    state: ReturnType<typeof createSessionState>,
    blockId: number,
    summaryTokens: number,
) {
    state.prune.messages.activeBlockIds.add(blockId)
    state.prune.messages.blocksById.set(blockId, {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens,
        durationMs: 0,
        topic: `Block ${blockId}`,
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: `msg-anchor-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: `[Compressed conversation section] body ${blockId}`,
    })
}

test("findReclaimableRegions returns uncovered runs sorted by size", () => {
    const state = createSessionState()
    const messages = [
        buildMessage("big-1", "user", "A".repeat(8000)),
        buildMessage("big-2", "assistant", "B".repeat(8000)),
        buildSyntheticSummary("msg_dcp_summary_a", "[Compressed conversation section] small"),
        buildMessage("small-1", "user", "C".repeat(400)),
        buildSyntheticSummary("msg_dcp_summary_b", "[Compressed conversation section] small2"),
        buildMessage("tail-1", "user", "tail"),
    ]
    assignRefs(state, messages)
    addActiveBlock(state, 11, 1600)

    const map = findReclaimableRegions(state, messages)
    assert.equal(map.uncovered.length, 3)
    assert.equal(map.uncovered[0]?.startRef, "m0001")
    assert.equal(map.uncovered[0]?.endRef, "m0002")
    assert.ok((map.uncovered[0]?.estimatedTokens ?? 0) > (map.uncovered[1]?.estimatedTokens ?? 0))
    assert.equal(map.blockSummaries[0]?.blockId, 11)
    assert.ok(map.totalVisibleTokens > 0)
})

test("findReclaimableRegions detects uncovered regions in raw view via active coverage", () => {
    const state = createSessionState()
    const messages = [
        buildMessage("r1", "user", "X".repeat(9000)),
        buildMessage("covered", "assistant", "already compressed"),
        buildMessage("tail", "user", "tail"),
    ]
    assignRefs(state, messages)
    state.prune.messages.byMessageId.set("covered", {
        tokenCount: 50,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    addActiveBlock(state, 1, 2000)

    const map = findReclaimableRegions(state, messages)
    assert.equal(map.uncovered.length, 2)
    assert.equal(map.uncovered[0]?.startRef, "m0001")
    assert.equal(map.uncovered[0]?.endRef, "m0001")
})

test("renderReclaimableGuidance names the largest region first with a size hint", () => {
    const state = createSessionState()
    const messages = [
        buildMessage("big-1", "user", "A".repeat(20000)),
        buildMessage("big-2", "assistant", "B".repeat(20000)),
        buildSyntheticSummary("msg_dcp_summary_a", "[Compressed conversation section]"),
        buildMessage("small", "user", "tiny"),
    ]
    assignRefs(state, messages)
    addActiveBlock(state, 7, 1200)

    const guidance = renderReclaimableGuidance(state, messages)
    assert.match(guidance, /RECLAIMABLE/)
    assert.match(guidance, /m0001\.\.m0002/)
    assert.match(guidance, /b7/)
})

test("renderReclaimableGuidance stays quiet when nothing is uncovered and no blocks exist", () => {
    const state = createSessionState()
    const messages = [buildMessage("only", "user", "hello")]
    assignRefs(state, messages)

    const guidance = renderReclaimableGuidance(state, messages)
    assert.equal(guidance.trim(), "")
})

test("buildCompressedBlockGuidance embeds the reclaimable cost map", () => {
    const state = createSessionState()
    const messages = [
        buildMessage("big-1", "user", "A".repeat(20000)),
        buildMessage("big-2", "assistant", "B".repeat(20000)),
        buildSyntheticSummary("msg_dcp_summary_a", "[Compressed conversation section]"),
        buildMessage("small", "user", "tiny"),
    ]
    assignRefs(state, messages)
    addActiveBlock(state, 7, 1200)

    const guidance = buildCompressedBlockGuidance(state, messages)
    assert.match(guidance, /Active compressed blocks/)
    assert.match(guidance, /RECLAIMABLE CONTEXT MAP/)
    assert.match(guidance, /m0001\.\.m0002/)
})

test("renderReclaimableGuidance uses compact block refs for compact sessions", () => {
    const state = createSessionState("compact")
    const messages = [
        buildMessage("big-1", "user", "A".repeat(20000)),
        buildSyntheticSummary("msg_dcp_summary_a", "[Compressed conversation section]"),
    ]
    assignRefs(state, messages)
    addActiveBlock(state, 7, 1200)

    const guidance = renderReclaimableGuidance(state, messages)
    assert.match(guidance, /@b7@/)
    assert.doesNotMatch(guidance, /b7 \(~/)
})

test("buildCompressedBlockGuidance keeps the merge example in the session id format", () => {
    const state = createSessionState("compact")
    const messages = [
        buildMessage("big-1", "user", "A".repeat(20000)),
        buildSyntheticSummary("msg_dcp_summary_a", "[Compressed conversation section]"),
    ]
    assignRefs(state, messages)
    addActiveBlock(state, 1, 1200)
    addActiveBlock(state, 2, 900)

    const guidance = buildCompressedBlockGuidance(state, messages)
    assert.match(guidance, /@b1@/)
    assert.match(guidance, /@bN@/)
    assert.doesNotMatch(guidance, /from b1 to b2/)
})
