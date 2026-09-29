import assert from "node:assert/strict"
import test from "node:test"
import "./lab/persistence-env"
import { createCompressMessageTool } from "../lib/compress/message"
import { createCompressRangeTool } from "../lib/compress/range"
import { handleDecompressCommand } from "../lib/commands/decompress"
import { handleRecompressCommand } from "../lib/commands/recompress"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

// XDG sandbox lives in ./lab/persistence-env (must be imported before lib).

function buildConfig(mode: "message" | "range"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode,
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "I mapped the code path")],
        },
        {
            info: {
                id: "msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-2", sessionID, "part-3", "I also ran a task tool"),
                toolPart("msg-assistant-2", sessionID, "call-task-1", "task", "task output body"),
            ],
        },
    ]
}

function appendOriginMessage(rawMessages: WithParts[], sessionID: string, messageID: string): void {
    rawMessages.push({
        info: {
            id: messageID,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: rawMessages.length + 1 },
        } as WithParts["info"],
        parts: [textPart(messageID, sessionID, `${messageID}-part`, "compress tool output")],
    })
}

test("compression notifications increment by tool call across range and message tools", async () => {
    const sessionID = `ses_compression_notifications_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const toastCalls: string[] = []
    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
        },
        tui: {
            showToast: async ({ body }: { body: { message: string } }) => {
                toastCalls.push(body.message)
            },
        },
    }

    const rangeConfig = buildConfig("range")
    rangeConfig.pruneNotification = "detailed"
    rangeConfig.pruneNotificationType = "toast"
    const messageConfig = buildConfig("message")
    messageConfig.pruneNotification = "detailed"
    messageConfig.pruneNotificationType = "toast"

    const rangeTool = createCompressRangeTool({
        client,
        state,
        logger,
        config: rangeConfig,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await rangeTool.execute(
        {
            topic: "Range batch",
            content: [
                {
                    startId: "m0001",
                    endId: "m0001",
                    summary: "Captured the opening user request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-origin",
        },
    )

    appendOriginMessage(rawMessages, sessionID, "msg-compress-range-origin")

    const messageTool = createCompressMessageTool({
        client,
        state,
        logger,
        config: messageConfig,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await messageTool.execute(
        {
            topic: "Message batch",
            content: [
                {
                    messageId: "m0002",
                    topic: "Code path note",
                    summary: "Captured the assistant code-path findings.",
                },
                {
                    messageId: "m0003",
                    topic: "Task output note",
                    summary: "Captured the assistant task-backed follow-up.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-message-origin",
        },
    )

    assert.equal(toastCalls.length, 2)
    assert.match(toastCalls[0] || "", /Compression #1/)
    assert.match(toastCalls[1] || "", /Compression #2/)
})

test("decompress groups batched message compressions by tool call", async () => {
    const sessionID = `ses_message_grouped_decompress_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const ignoredMessages: string[] = []
    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    const tool = createCompressMessageTool({
        client,
        state,
        logger,
        config: buildConfig("message"),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await tool.execute(
        {
            topic: "Batch stale notes",
            content: [
                {
                    messageId: "m0002",
                    topic: "Code path note",
                    summary: "Captured the assistant code-path findings.",
                },
                {
                    messageId: "m0003",
                    topic: "Task output note",
                    summary: "Captured the assistant task-backed follow-up.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-message-group",
        },
    )

    appendOriginMessage(rawMessages, sessionID, "msg-compress-message-group")

    const blocks = Array.from(state.prune.messages.blocksById.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]?.runId, blocks[1]?.runId)
    assert.equal(blocks[0]?.batchTopic, "Batch stale notes")

    await handleDecompressCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const groupedListMessage = ignoredMessages.pop() || ""
    assert.match(groupedListMessage, /Compression #1 - 2 messages - Batch stale notes/)
    assert.doesNotMatch(groupedListMessage, /Code path note/)

    await handleDecompressCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [String(blocks[0]?.blockId || 1)],
    })

    assert.ok(blocks.every((block) => block.deactivatedByUser))
    assert.ok(blocks.every((block) => !block.active))

    await handleRecompressCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [String(blocks[0]?.blockId || 1)],
    })

    assert.ok(blocks.every((block) => !block.deactivatedByUser))
    assert.ok(blocks.every((block) => block.active))
})

test("decompress keeps batched ranges individually restorable", async () => {
    const sessionID = `ses_range_individual_decompress_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const ignoredMessages: string[] = []
    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    const tool = createCompressRangeTool({
        client,
        state,
        logger,
        config: buildConfig("range"),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await tool.execute(
        {
            topic: "Batch stale notes",
            content: [
                {
                    startId: "m0001",
                    endId: "m0001",
                    summary: "Captured the opening user request.",
                },
                {
                    startId: "m0002",
                    endId: "m0002",
                    summary: "Captured the assistant code-path findings.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-group",
        },
    )

    appendOriginMessage(rawMessages, sessionID, "msg-compress-range-group")

    const blocks = Array.from(state.prune.messages.blocksById.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]?.runId, blocks[1]?.runId)

    await handleDecompressCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const listMessage = ignoredMessages.pop() || ""
    assert.match(listMessage, /1 \(.+\)\s+Compression #1 - Batch stale notes/)
    assert.match(listMessage, /2 \(.+\)\s+Compression #1 - Batch stale notes/)

    await handleDecompressCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [String(blocks[0]?.blockId || 1)],
    })

    assert.equal(blocks[0]?.deactivatedByUser, true)
    assert.equal(blocks[0]?.active, false)
    assert.equal(blocks[1]?.active, true)
    assert.equal(blocks[1]?.deactivatedByUser, false)
})
