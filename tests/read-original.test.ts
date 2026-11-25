import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createReadOriginalTool } from "../lib/investigate/read-original"
import {
    parseBlockIdArg,
    resolveBlockSlice,
    serializeMessages,
    truncateMessages,
} from "../lib/investigate/resolve"
import { createSessionState, type CompressionBlock, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-read-original-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
mkdirSync(testDataHome, { recursive: true })

function buildBlock(blockId: number, messageIds: string[], topic?: string): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs: 100,
        mode: "range",
        topic: topic ?? `topic-${blockId}`,
        batchTopic: `topic-${blockId}`,
        startId: `m${blockId}`,
        endId: `m${blockId}`,
        anchorMessageId: messageIds[0] ?? `msg-${blockId}`,
        compressMessageId: `origin-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: messageIds,
        directToolIds: [],
        effectiveMessageIds: messageIds,
        effectiveToolIds: [],
        createdAt: blockId,
        summary: `summary-${blockId}`,
    }
}

function textMessage(
    sessionID: string,
    id: string,
    role: "user" | "assistant",
    text: string,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID,
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID,
                type: "text" as const,
                text,
            },
        ],
    }
}

test("parseBlockIdArg accepts bN, N, and rejects garbage", () => {
    assert.equal(parseBlockIdArg("b3"), 3)
    assert.equal(parseBlockIdArg("B5"), 5)
    assert.equal(parseBlockIdArg("  b7  "), 7)
    assert.equal(parseBlockIdArg("12"), 12)
    assert.equal(parseBlockIdArg("abc"), null)
    assert.equal(parseBlockIdArg("0"), null)
    assert.equal(parseBlockIdArg(""), null)
})

test("resolveBlockSlice maps a block back to its original messages", () => {
    const sessionID = "ses-resolve"
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, buildBlock(1, ["msg-a", "msg-b"]))

    const rawMessages = [
        textMessage(sessionID, "msg-a", "user", "first"),
        textMessage(sessionID, "msg-keep", "assistant", "unrelated"),
        textMessage(sessionID, "msg-b", "assistant", "second"),
    ]

    const slice = resolveBlockSlice(state, rawMessages, 1)
    assert.equal(slice.blockRef, "b1")
    assert.deepEqual(
        slice.messages.map((m) => m.info.id),
        ["msg-a", "msg-b"],
    )
})

test("resolveBlockSlice throws for a missing block", () => {
    const state = createSessionState()
    assert.throws(() => resolveBlockSlice(state, [], 99), /does not exist/)
})

test("resolveBlockSlice falls back to directMessageIds when effective is empty", () => {
    const state = createSessionState()
    const block = buildBlock(1, ["msg-a"])
    block.effectiveMessageIds = []
    state.prune.messages.blocksById.set(1, block)

    const rawMessages = [textMessage("ses-fallback", "msg-a", "user", "hello")]
    const slice = resolveBlockSlice(state, rawMessages, 1)
    assert.deepEqual(
        slice.messages.map((m) => m.info.id),
        ["msg-a"],
    )
})

test("serializeMessages formats roles and text parts", () => {
    const messages = [
        textMessage("ses-s", "msg-a", "user", "question here"),
        textMessage("ses-s", "msg-b", "assistant", "answer here"),
    ]
    const output = serializeMessages(messages)
    assert.match(output, /### user/)
    assert.match(output, /question here/)
    assert.match(output, /### assistant/)
    assert.match(output, /answer here/)
})

test("truncateMessages returns untruncated output when no budget is set", () => {
    const messages = [textMessage("ses-t", "msg-a", "user", "hello")]
    const result = truncateMessages(messages)
    assert.equal(result.truncated, false)
    assert.match(result.text, /hello/)
})

test("truncateMessages marks truncated when budget is too small", () => {
    const messages = [
        textMessage("ses-t2", "msg-a", "user", "a very long sentence that should exceed one token"),
        textMessage(
            "ses-t2",
            "msg-b",
            "assistant",
            "another very long sentence to push over budget",
        ),
    ]
    const result = truncateMessages(messages, 1)
    assert.equal(result.truncated, true)
})

test("read_original tool returns the original content for a block", async () => {
    const sessionID = `ses_read_original_${Date.now()}`
    const rawMessages = [
        textMessage(sessionID, "msg-a", "user", "what does foo do?"),
        textMessage(sessionID, "msg-b", "assistant", "foo does the thing."),
    ]

    const state = createSessionState()
    state.sessionId = sessionID
    state.prune.messages.blocksById.set(1, buildBlock(1, ["msg-a", "msg-b"]))

    const logger = new Logger(false)
    const tool = createReadOriginalTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
    } as any)

    const result = await tool.execute(
        { blockId: "b1" },
        { ask: async () => {}, metadata: () => {}, sessionID, messageID: "msg-call" },
    )

    assert.match(result, /Original content of compression b1/)
    assert.match(result, /what does foo do\?/)
    assert.match(result, /foo does the thing\./)
})

test("read_original tool rejects an invalid block reference", async () => {
    const sessionID = `ses_read_original_bad_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)
    const tool = createReadOriginalTool({
        client: {
            session: {
                messages: async () => ({ data: [] }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
    } as any)

    await assert.rejects(
        tool.execute(
            { blockId: "nope" },
            { ask: async () => {}, metadata: () => {}, sessionID, messageID: "msg-call" },
        ),
        /Invalid block reference/,
    )
})
