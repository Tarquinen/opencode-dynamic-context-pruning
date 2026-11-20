import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { normalizeRangeArgs, validateArgs } from "../lib/compress/range-utils"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

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
test("compress range normalizes single-object content into an array", () => {
    const input = normalizeRangeArgs({
        topic: "Range fix",
        content: { startId: "m0001", endId: "m0002", summary: "Summary text." },
    })
    assert.deepEqual(input.content, [
        { startId: "m0001", endId: "m0002", summary: "Summary text." },
    ])
    assert.doesNotThrow(() => validateArgs(input))
})

test("compress range normalizes JSON-string content into an array", () => {
    const arrayInput = normalizeRangeArgs({
        topic: "Range fix",
        content: JSON.stringify([{ startId: "m0001", endId: "m0002", summary: "Summary text." }]),
    })
    assert.equal(arrayInput.content.length, 1)
    assert.equal(arrayInput.content[0].startId, "m0001")
    assert.doesNotThrow(() => validateArgs(arrayInput))

    const objectInput = normalizeRangeArgs({
        topic: "Range fix",
        content: JSON.stringify({ startId: "m0003", endId: "m0004", summary: "Another." }),
    })
    assert.equal(objectInput.content.length, 1)
    assert.equal(objectInput.content[0].endId, "m0004")
    assert.doesNotThrow(() => validateArgs(objectInput))
})

test("compress range rejects plain-string content with re-send guidance", () => {
    assert.throws(
        () =>
            normalizeRangeArgs({
                topic: "Range fix",
                content: "A plain summary without range boundaries.",
            }),
        (err: Error) =>
            err.message.includes("JSON array") &&
            err.message.includes("startId") &&
            err.message.includes("endId"),
    )
})

test("compress range still rejects empty content arrays", () => {
    const input = normalizeRangeArgs({ topic: "Range fix", content: [] })
    assert.throws(() => validateArgs(input), /content is required and must be a non-empty array/)
})

test("compress range rejects a JSON-encoded empty content array with the non-empty error", () => {
    assert.throws(
        () => normalizeRangeArgs({ topic: "Range fix", content: "[]" }),
        /content is required and must be a non-empty array/,
    )
})

test("compress range rejects a whole-args string with re-send guidance", () => {
    assert.throws(
        () => normalizeRangeArgs("Just a summary string."),
        (err: Error) => err.message.includes('"topic"') && err.message.includes('"content"'),
    )
})

test("compress range execute rejects the captured string-content payload with guidance", async () => {
    // Replay of a real-world failure captured from opencode sessions: the model
    // sent the summary as a plain `content` string and the tool errored with
    // "content is required and must be a non-empty array", forcing a retry.
    const tool = createCompressRangeTool({
        client: {},
        state: createSessionState(),
        logger: new Logger(false),
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
                topic: "XKBNotFound bug diagnosis (Phases 1-4)",
                content:
                    "User bug report (verbatim intent): `just run` fails — xkbcommon-dl fails to dlopen libxkbcommon.so.0.",
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID: "ses_string_content_replay",
                messageID: "msg-compress-string-content",
            },
        ),
        (err: Error) =>
            err.message.includes("JSON array") &&
            err.message.includes("startId") &&
            err.message.includes("endId"),
    )
})
