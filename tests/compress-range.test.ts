import assert from "node:assert/strict"
import test from "node:test"
import "./lab/persistence-env"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

// XDG sandbox lives in ./lab/persistence-env (must be imported before lib).

function buildConfig(): PluginConfig {
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
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
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

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-subagent-prompt",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-subagent-prompt", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "part-2", "I found the relevant code path"),
            ],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-user-2", sessionID, "part-3", "Please compress the initial findings"),
            ],
        },
    ]
}

test("compress range rebuilds subagent message refs after session state was reset", async () => {
    const sessionID = `ses_subagent_compress_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.sessionId = "ses_other"
    state.messageIds.byRawId.set("other-message", "m0001")
    state.messageIds.byRef.set("m0001", "other-message")
    state.messageIds.nextRef = 2

    const logger = new Logger(false)
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Subagent race fix",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "Captured the initial investigation and follow-up request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        },
    )

    assert.equal(result, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(state.sessionId, sessionID)
    assert.equal(state.isSubAgent, true)
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-assistant-1")
    assert.equal(state.messageIds.byRef.get("m0002"), "msg-user-2")
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("compress range mode appends protected prompt info", async () => {
    const sessionID = `ses_range_protect_tag_${Date.now()}`
    const rawMessages: WithParts[] = [
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
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "part-user-1",
                    "Investigate the release. <protect>Keep the npm publish token note.</protect>",
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-assistant-1", "I checked it")],
        },
    ]

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.compress.protectTags = true
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await tool.execute(
        {
            topic: "Protected range",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "Captured release investigation.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-protect-tag",
        },
    )

    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.match(
        block?.summary || "",
        /The following protected prompt information was included in this conversation verbatim:/,
    )
    assert.match(block?.summary || "", /Keep the npm publish token note\./)
})

test("compress range mode batches multiple ranges into one notification", async () => {
    const sessionID = `ses_range_compress_batch_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.pruneNotification = "detailed"
    config.pruneNotificationType = "toast"

    const toastCalls: string[] = []
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
            tui: {
                showToast: async ({ body }: { body: { message: string } }) => {
                    toastCalls.push(body.message)
                },
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Batch stale notes",
            content: [
                {
                    startId: "m0001",
                    endId: "m0001",
                    summary: "Captured the initial assistant investigation.",
                },
                {
                    startId: "m0002",
                    endId: "m0002",
                    summary: "Captured the follow-up user request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-batch",
        },
    )

    assert.equal(result, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(state.prune.messages.blocksById.size, 2)
    assert.equal(toastCalls.length, 1)
    assert.match(toastCalls[0] || "", /▣ DCP \| -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(toastCalls[0] || "", /Compression #1/)
    assert.match(toastCalls[0] || "", /▣ Compression #1 -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(toastCalls[0] || "", /Topic: Batch stale notes/)
    assert.match(toastCalls[0] || "", /Items: 2 messages/)
})

test("compress range mode rejects overlapping batched ranges", async () => {
    const sessionID = `ses_range_compress_overlap_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await assert.rejects(
        tool.execute(
            {
                topic: "Overlapping ranges",
                content: [
                    {
                        startId: "m0001",
                        endId: "m0002",
                        summary: "Captured the initial investigation and follow-up request.",
                    },
                    {
                        startId: "m0002",
                        endId: "m0002",
                        summary: "Captured the follow-up request again.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-compress-range-overlap",
            },
        ),
        /Overlapping ranges cannot be compressed in the same batch/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})
