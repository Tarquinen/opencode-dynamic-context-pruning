import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createInvestigateTool } from "../lib/investigate/investigate"
import { runInvestigation } from "../lib/investigate/subagent"
import { createSessionState, type CompressionBlock, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-investigate-${process.pid}`)
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

test("runInvestigation spawns a child session, returns the answer, and cleans up", async () => {
    const parentSessionId = "ses-parent"
    const calls: { create?: any; prompt?: any; deletedId?: string } = {}

    const client = {
        session: {
            create: async (input: any) => {
                calls.create = input
                return { data: { id: "child-1" } }
            },
            prompt: async (input: any) => {
                calls.prompt = input
                return { data: { parts: [{ type: "text", text: "the answer" }] } }
            },
            messages: async () => ({ data: [] }),
            delete: async (input: any) => {
                calls.deletedId = input.path.id
                return { data: true }
            },
        },
    }

    const block = buildBlock(1, ["msg-a"], "some topic")
    const logger = new Logger(false)

    const answer = await runInvestigation(
        client,
        logger,
        parentSessionId,
        block,
        "b1",
        "what happened?",
        "original content",
    )

    assert.equal(answer, "the answer")
    assert.equal(calls.create.body.parentID, parentSessionId)
    assert.match(calls.create.body.title, /b1/)
    assert.equal(calls.prompt.path.id, "child-1")
    assert.match(calls.prompt.body.parts[0].text, /original content/)
    assert.match(calls.prompt.body.parts[0].text, /what happened\?/)
    assert.equal(calls.deletedId, "child-1")
})

test("runInvestigation falls back to polling messages when prompt returns no text", async () => {
    const client = {
        session: {
            create: async () => ({ data: { id: "child-2" } }),
            prompt: async () => ({ data: { parts: [] } }),
            messages: async () => ({
                data: [
                    { info: { role: "user" }, parts: [{ type: "text", text: "prompt" }] },
                    {
                        info: { role: "assistant" },
                        parts: [{ type: "text", text: "fallback answer" }],
                    },
                ],
            }),
            delete: async () => ({ data: true }),
        },
    }

    const answer = await runInvestigation(
        client,
        new Logger(false),
        "ses-parent",
        buildBlock(1, ["msg-a"]),
        "b1",
        "q?",
        "content",
    )
    assert.equal(answer, "fallback answer")
})

test("investigate tool returns an answer without raw content in main context", async () => {
    const sessionID = `ses_investigate_${Date.now()}`
    const rawMessages = [textMessage(sessionID, "msg-a", "user", "the secret original message")]

    const state = createSessionState()
    state.sessionId = sessionID
    state.prune.messages.blocksById.set(1, buildBlock(1, ["msg-a"]))

    let deletedId: string | undefined

    const logger = new Logger(false)
    const tool = createInvestigateTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
                create: async () => ({ data: { id: "child-3" } }),
                prompt: async () => ({
                    data: { parts: [{ type: "text", text: "subagent answer" }] },
                }),
                delete: async (input: any) => {
                    deletedId = input.path.id
                    return { data: true }
                },
            },
        },
        state,
        logger,
    } as any)

    const result = await tool.execute(
        { blockId: "b1", question: "what was the secret?" },
        { ask: async () => {}, metadata: () => {}, sessionID, messageID: "msg-call" },
    )

    assert.equal(result, "subagent answer")
    assert.equal(deletedId, "child-3")
})

test("investigate tool rejects an invalid block reference", async () => {
    const sessionID = `ses_investigate_bad_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const tool = createInvestigateTool({
        client: {
            session: {
                messages: async () => ({ data: [] }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger: new Logger(false),
    } as any)

    await assert.rejects(
        tool.execute(
            { blockId: "bad", question: "q" },
            { ask: async () => {}, metadata: () => {}, sessionID, messageID: "msg-call" },
        ),
        /Invalid block reference/,
    )
})
