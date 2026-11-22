import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { hasCompressHistory, reconstructFromHistory } from "../lib/compress/reconstruct"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-reconstruct-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-reconstruct-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function compressToolPart(
    messageID: string,
    sessionID: string,
    id: string,
    callID: string,
    topic: string,
    content: Array<{ startId: string; endId: string; summary: string }>,
) {
    return {
        id,
        messageID,
        sessionID,
        callID,
        type: "tool" as const,
        tool: "compress",
        state: {
            status: "completed" as const,
            input: { topic, content },
            output: `Compressed ${content.length} messages into [Compressed conversation section].`,
        },
    }
}

function buildForkedSessionMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "fork-msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 100 },
            } as WithParts["info"],
            parts: [textPart("fork-msg-user-1", sessionID, "p1", "Hello")],
        },
        {
            info: {
                id: "fork-msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 200 },
            } as WithParts["info"],
            parts: [textPart("fork-msg-assistant-1", sessionID, "p2", "Hi there, how can I help?")],
        },
        {
            info: {
                id: "fork-msg-user-2",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 300 },
            } as WithParts["info"],
            parts: [textPart("fork-msg-user-2", sessionID, "p3", "Tell me about the system")],
        },
        {
            info: {
                id: "fork-msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 400 },
            } as WithParts["info"],
            parts: [
                textPart("fork-msg-assistant-2", sessionID, "p4", "The system has three components"),
                compressToolPart(
                    "fork-msg-assistant-2",
                    sessionID,
                    "p5",
                    "call-compress-1",
                    "Initial greeting",
                    [
                        {
                            startId: "m0001",
                            endId: "m0002",
                            summary: "User greeted and assistant responded with offer to help.",
                        },
                    ],
                ),
            ],
        },
        {
            info: {
                id: "fork-msg-user-3",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 500 },
            } as WithParts["info"],
            parts: [textPart("fork-msg-user-3", sessionID, "p6", "Can you compress more?")],
        },
    ]
}

test("hasCompressHistory returns true when messages contain completed compress tool calls", () => {
    const messages = buildForkedSessionMessages("ses_test_1")
    assert.equal(hasCompressHistory(messages), true)
})

test("hasCompressHistory returns false when no compress tool calls exist", () => {
    const sessionID = "ses_test_2"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 100 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "p1", "Hello")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 200 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "p2", "Hi there")],
        },
    ]
    assert.equal(hasCompressHistory(messages), false)
})

test("reconstructFromHistory rebuilds compression state from compress tool results", () => {
    const sessionID = "ses_fork_reconstruct_1"
    const messages = buildForkedSessionMessages(sessionID)
    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)

    assignMessageRefs(state, messages)

    assert.equal(state.messageIds.byRef.get("m0001"), "fork-msg-user-1")
    assert.equal(state.messageIds.byRef.get("m0002"), "fork-msg-assistant-1")

    const reconstructed = reconstructFromHistory(state, logger, messages)

    assert.equal(reconstructed, 1)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.prune.messages.activeBlockIds.size, 1)

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.equal(block.active, true)
    assert.equal(block.topic, "Initial greeting")
    assert.equal(block.compressMessageId, "fork-msg-assistant-2")
    assert.equal(block.compressCallId, "call-compress-1")
    assert.equal(block.startId, "m0001")
    assert.equal(block.endId, "m0002")

    const entry1 = state.prune.messages.byMessageId.get("fork-msg-user-1")
    assert.ok(entry1)
    assert.ok(entry1.activeBlockIds.includes(1))

    const entry2 = state.prune.messages.byMessageId.get("fork-msg-assistant-1")
    assert.ok(entry2)
    assert.ok(entry2.activeBlockIds.includes(1))
})

test("reconstructFromHistory handles multiple sequential compressions", () => {
    const sessionID = "ses_fork_reconstruct_2"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-u1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 100 },
            } as WithParts["info"],
            parts: [textPart("msg-u1", sessionID, "p1", "First message")],
        },
        {
            info: {
                id: "msg-a1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 200 },
            } as WithParts["info"],
            parts: [textPart("msg-a1", sessionID, "p2", "First response")],
        },
        {
            info: {
                id: "msg-u2",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 300 },
            } as WithParts["info"],
            parts: [textPart("msg-u2", sessionID, "p3", "Second message")],
        },
        {
            info: {
                id: "msg-a2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 400 },
            } as WithParts["info"],
            parts: [
                textPart("msg-a2", sessionID, "p4", "Second response"),
                compressToolPart("msg-a2", sessionID, "p5", "call-1", "First compression", [
                    {
                        startId: "m0001",
                        endId: "m0002",
                        summary: "First exchange summary.",
                    },
                ]),
            ],
        },
        {
            info: {
                id: "msg-u3",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 500 },
            } as WithParts["info"],
            parts: [textPart("msg-u3", sessionID, "p6", "Third message")],
        },
        {
            info: {
                id: "msg-a3",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 600 },
            } as WithParts["info"],
            parts: [
                textPart("msg-a3", sessionID, "p7", "Third response"),
                compressToolPart("msg-a3", sessionID, "p8", "call-2", "Second compression", [
                    {
                        startId: "m0003",
                        endId: "m0004",
                        summary: "Second exchange summary.",
                    },
                ]),
            ],
        },
        {
            info: {
                id: "msg-u4",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 700 },
            } as WithParts["info"],
            parts: [textPart("msg-u4", sessionID, "p9", "Fourth message")],
        },
    ]

    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)

    assignMessageRefs(state, messages)
    const reconstructed = reconstructFromHistory(state, logger, messages)

    assert.equal(reconstructed, 2)
    assert.equal(state.prune.messages.blocksById.size, 2)

    const block1 = state.prune.messages.blocksById.get(1)
    assert.ok(block1)
    assert.equal(block1.topic, "First compression")
    assert.equal(block1.compressMessageId, "msg-a2")

    const block2 = state.prune.messages.blocksById.get(2)
    assert.ok(block2)
    assert.equal(block2.topic, "Second compression")
    assert.equal(block2.compressMessageId, "msg-a3")
})

test("reconstructFromHistory handles block refs (bN) in ranges by consuming earlier blocks", () => {
    const sessionID = "ses_fork_reconstruct_3"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-u1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 100 },
            } as WithParts["info"],
            parts: [textPart("msg-u1", sessionID, "p1", "First message")],
        },
        {
            info: {
                id: "msg-a1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 200 },
            } as WithParts["info"],
            parts: [textPart("msg-a1", sessionID, "p2", "First response")],
        },
        {
            info: {
                id: "msg-u2",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 300 },
            } as WithParts["info"],
            parts: [textPart("msg-u2", sessionID, "p3", "Second message")],
        },
        {
            info: {
                id: "msg-a2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 400 },
            } as WithParts["info"],
            parts: [
                textPart("msg-a2", sessionID, "p4", "Second response with compress"),
                compressToolPart("msg-a2", sessionID, "p5", "call-1", "First block", [
                    {
                        startId: "m0001",
                        endId: "m0002",
                        summary: "First exchange compressed.",
                    },
                ]),
            ],
        },
        {
            info: {
                id: "msg-u3",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 500 },
            } as WithParts["info"],
            parts: [textPart("msg-u3", sessionID, "p6", "Third message")],
        },
        {
            info: {
                id: "msg-a3",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 600 },
            } as WithParts["info"],
            parts: [textPart("msg-a3", sessionID, "p7", "Third response")],
        },
        {
            info: {
                id: "msg-u4",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 700 },
            } as WithParts["info"],
            parts: [textPart("msg-u4", sessionID, "p8", "Fourth message")],
        },
        {
            info: {
                id: "msg-a4",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 800 },
            } as WithParts["info"],
            parts: [
                textPart("msg-a4", sessionID, "p9", "Fourth response with mega compress"),
                compressToolPart("msg-a4", sessionID, "p10", "call-2", "Mega block", [
                    {
                        startId: "b1",
                        endId: "m0006",
                        summary: "Everything up to third response compressed.",
                    },
                ]),
            ],
        },
        {
            info: {
                id: "msg-u5",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 900 },
            } as WithParts["info"],
            parts: [textPart("msg-u5", sessionID, "p11", "Latest message")],
        },
    ]

    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)

    assignMessageRefs(state, messages)
    const reconstructed = reconstructFromHistory(state, logger, messages)

    assert.equal(reconstructed, 2)

    const block1 = state.prune.messages.blocksById.get(1)
    assert.ok(block1)
    assert.equal(block1.active, false)

    const block2 = state.prune.messages.blocksById.get(2)
    assert.ok(block2)
    assert.equal(block2.active, true)
    assert.equal(block2.startId, "b1")
    assert.equal(block2.endId, "m0006")

    assert.equal(state.prune.messages.activeBlockIds.size, 1)
    assert.ok(state.prune.messages.activeBlockIds.has(2))
})

test("reconstructFromHistory returns 0 when no compress results exist", () => {
    const sessionID = "ses_fork_no_compress"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-u1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 100 },
            } as WithParts["info"],
            parts: [textPart("msg-u1", sessionID, "p1", "Hello")],
        },
    ]

    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)

    assignMessageRefs(state, messages)
    const reconstructed = reconstructFromHistory(state, logger, messages)
    assert.equal(reconstructed, 0)
    assert.equal(state.prune.messages.blocksById.size, 0)
})
