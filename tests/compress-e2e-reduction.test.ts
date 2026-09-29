import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import type { Message } from "@opencode/ai/schema/messages"
import { project } from "../lib/v2/messages"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { createCompressRangeTool } from "../lib/compress/range"
import { COMPRESSED_BLOCK_HEADER } from "../lib/compress/state"
import { syncCompressionBlocks, prune } from "../lib/messages"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { countTokens } from "../lib/token-utils"

/**
 * End-to-end proof for the anti-shadowing fix: DCP's compress tool registers
 * as "dcp_compress" (the sleev gateway injects its own `compress` tool that
 * schedules but never applies anything). Invoking DCP's tool handler against
 * a fixture transcript must persist a compression block in session state
 * (the artifact that survives host restarts), and the host request-time
 * transform (project -> syncCompressionBlocks -> prune -> restore) must
 * return a measurably smaller message list with the compressed range
 * replaced by the summary block.
 */

const session = {
    id: "ses_e2e",
    agent: "build",
    model: { id: "test", providerID: "test" },
} as Parameters<typeof project>[2]

const config: PluginConfig = {
    enabled: true,
    debug: false,
    pruneNotification: "off",
    pruneNotificationType: "chat",
    commands: { enabled: true, protectedTools: [] },
    manualMode: { enabled: false, automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    experimental: { allowSubAgents: true, customPrompts: false },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        toolName: "dcp_compress",
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
        deduplication: { enabled: true, protectedTools: [] },
        purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
    },
}
const logger = new Logger(false)

const PAD_A = "MARKER-A deep implementation detail worth compressing. ".repeat(30)
const PAD_B = "MARKER-B later analysis that must survive compression. ".repeat(30)

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function rawTranscript(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-1",
                role: "user",
                sessionID,
                agent: "build",
                model: { providerID: "test", modelID: "test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-1", sessionID, "part-1", "Please investigate the bug.")],
        },
        {
            info: {
                id: "msg-2",
                role: "assistant",
                sessionID,
                agent: "build",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-2", sessionID, "part-2", PAD_A)],
        },
        {
            info: {
                id: "msg-3",
                role: "user",
                sessionID,
                agent: "build",
                model: { providerID: "test", modelID: "test" },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-3", sessionID, "part-3", "What did you find?")],
        },
        {
            info: {
                id: "msg-4",
                role: "assistant",
                sessionID,
                agent: "build",
                time: { created: 4 },
            } as WithParts["info"],
            parts: [textPart("msg-4", sessionID, "part-4", PAD_B)],
        },
    ]
}

function v2Transcript(): Message[] {
    return [
        { id: "msg-1", role: "user", content: [{ type: "text", text: "Please investigate the bug." }] },
        { id: "msg-2", role: "assistant", content: [{ type: "text", text: PAD_A }] },
        { id: "msg-3", role: "user", content: [{ type: "text", text: "What did you find?" }] },
        { id: "msg-4", role: "assistant", content: [{ type: "text", text: PAD_B }] },
    ] as Message[]
}

function entries(messages: Message[]) {
    return messages
        .filter((message) => message.id)
        .map((message) => ({
            id: message.id,
            type: message.role,
            time: { created: 1 },
            agent: "build",
            model: session.model,
            content: [],
            text: "",
        })) as Parameters<typeof project>[1]
}

test("compress tool execution shrinks the next request and persists the block", async () => {
    const sessionID = `ses_e2e_compress_${Date.now()}`
    const rawMessages = rawTranscript(sessionID)
    const native = v2Transcript()

    const state = createSessionState()

    // Request N: host assigns message refs exactly like the chat-message hook does.
    assignMessageRefs(state, project(native, entries(native), session).messages)

    // Between requests the model invokes DCP's compress tool ("dcp_compress").
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
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
            topic: "E2E reduction",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "The padded opening investigation and its key findings.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-tool",
        },
    )

    assert.equal(result, `Compressed 2 messages into ${COMPRESSED_BLOCK_HEADER}.`)
    // The compression lives in session state — the artifact that survives host restarts.
    assert.equal(state.prune.messages.blocksById.size, 1)

    // Request N+1: the host transform replaces the compressed range with the summary.
    const view = project(native, entries(native), session)
    assignMessageRefs(state, view.messages)
    syncCompressionBlocks(state, logger, view.messages)
    const before = countTokens(JSON.stringify(view.messages))
    prune(state, logger, config, view.messages)
    const restored = view.restore()
    const after = countTokens(JSON.stringify(restored))

    assert.ok(after < before, `expected token drop, got ${before} -> ${after}`)
    const restoredJson = JSON.stringify(restored)
    assert.ok(restoredJson.includes(COMPRESSED_BLOCK_HEADER), "summary block must be present")
    assert.match(restoredJson, /padded opening investigation/, "summary text must be present")
    assert.ok(!restoredJson.includes("MARKER-A"), "compressed range content must be gone")
    assert.ok(restoredJson.includes("MARKER-B"), "content after the range must survive")
})
