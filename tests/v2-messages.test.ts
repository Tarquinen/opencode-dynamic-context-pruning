import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import type { Message } from "@opencode/ai/schema/messages"
import { Media } from "@opencode/ai/media"
import { project } from "../lib/v2/messages"
import { createSessionState, type CompressionBlock } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { injectMessageIds, prune } from "../lib/messages"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const session = {
    id: "ses_test",
    agent: "build",
    model: { id: "test", providerID: "test" },
} as Parameters<typeof project>[2]
const config = {
    compress: { mode: "range", permission: "allow", protectUserMessages: false },
} as PluginConfig
const logger = new Logger(false)
function transcript(): Message[] {
    return [
        {
            role: "system",
            content: [{ type: "compaction", provider: "test", encrypted: "opaque-checkpoint" }],
        },
        {
            id: "msg_user",
            role: "user",
            content: [
                { type: "media", media: Media.bytes(new Uint8Array([0, 255]), "image/png") },
                { type: "text", text: "Inspect this", cache: { type: "ephemeral" } },
            ],
        },
        {
            id: "msg_assistant",
            role: "assistant",
            metadata: { host: true },
            content: [
                {
                    type: "reasoning",
                    text: "Reasoning",
                    encrypted: "signed-reasoning",
                    providerMetadata: { test: { signature: "original" } },
                },
                {
                    type: "tool-call",
                    id: "call_one",
                    name: "read",
                    input: { path: "one" },
                    providerMetadata: { test: { itemId: "fc_original" } },
                },
                { type: "tool-call", id: "call_two", name: "read", input: { path: "two" } },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "call_one",
                    name: "read",
                    result: { type: "text", value: "Original output" },
                    providerMetadata: { test: { replay: true } },
                },
                {
                    type: "tool-result",
                    id: "call_two",
                    name: "read",
                    result: {
                        type: "content",
                        value: [
                            { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" },
                        ],
                    },
                },
            ],
        },
        { id: "msg_latest", role: "user", content: [{ type: "text", text: "Continue" }] },
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

test("V2 projection preserves all native content without edits", () => {
    const messages = transcript()
    assert.deepEqual(project(messages, entries(messages), session).restore(), messages)
})

test("V2 request view drops DCP chat notifications but keeps look-alike assistant text", () => {
    const native: Message[] = [
        {
            id: "msg_user",
            role: "user",
            content: [{ type: "text", text: "Real user prompt" }],
        },
        {
            id: "msg_dcp_note",
            role: "user",
            content: [{ type: "text", text: "▣ DCP | ~1.2K saved total" }],
        },
        {
            id: "msg_trigger",
            role: "user",
            content: [
                { type: "text", text: "<compress triggered manually>\n\nManual trigger prompt" },
            ],
        },
        {
            id: "msg_assistant",
            role: "assistant",
            content: [{ type: "text", text: "The report starts with ▣ DCP | in the log" }],
        },
    ]
    const restored = project(native, entries(native), session).restore()
    // Manual-trigger prompts reach the model; only stamped DCP notes are dropped.
    assert.deepEqual(restored.map((message) => message.id), [
        "msg_user",
        "msg_trigger",
        "msg_assistant",
    ])
})

test("V2 history view skips DCP chat notifications entirely", async () => {
    const { history } = await import("../lib/v2/messages")
    const entries = [
        {
            id: "msg_user",
            type: "user",
            time: { created: 1 },
            text: "Real user prompt",
        },
        {
            id: "msg_note",
            type: "user",
            time: { created: 2 },
            text: "▣ DCP\nSweep report body",
        },
        {
            id: "msg_trigger",
            type: "user",
            time: { created: 3 },
            text: "<compress triggered manually>\n\nManual trigger prompt",
        },
    ] as unknown as Parameters<typeof history>[0]
    const views = history(entries, session as Parameters<typeof history>[1])
    assert.deepEqual(
        views.map((view) => view.info.id),
        ["msg_user", "msg_trigger"],
    )
})

test("V2 ID injection preserves signatures, media and tool pairing", () => {
    const native = transcript()
    const view = project(native, entries(native), session)
    const state = createSessionState("compact")
    assignMessageRefs(state, view.messages)
    injectMessageIds(state, config, view.messages, new Map())
    const restored = view.restore()
    assert.deepEqual(restored[0], native[0])
    assert.equal(restored[1]!.content[0], native[1]!.content[0])
    assert.equal(restored[2]!.content[0], native[2]!.content[0])
    assert.equal(restored[3]!.content[1], native[3]!.content[1])
    assert.match(JSON.stringify(restored[3]!.content[0]), /@2@/)
    assert.doesNotMatch(JSON.stringify(restored), /dcp-message-id|m0002/)
    assert.ok(!JSON.stringify(native).includes("@2@"), "native input must not be mutated")
})

test("V2 tool pruning replaces only marked results", () => {
    const native = transcript()
    const view = project(native, entries(native), session)
    const state = createSessionState("compact")
    state.prune.tools.set("call_one", 100)
    prune(state, logger, config, view.messages)
    const restored = view.restore()
    assert.match(JSON.stringify(restored[3]!.content[0]), /Output removed/)
    assert.equal(restored[3]!.content[1], native[3]!.content[1])
    assert.deepEqual(restored[2], native[2])
})

test("V2 compression removes the assistant and its ID-less results together", () => {
    const native = transcript()
    const view = project(native, entries(native), session)
    const state = createSessionState("compact")
    state.prune.messages.byMessageId.set("msg_assistant", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    prune(state, logger, config, view.messages)
    const restored = view.restore()
    assert.deepEqual(restored, [native[0], native[1], native[4]])
})

test("V2 leaves non-durable plugin messages and checkpoint tool results intact", () => {
    const native = transcript()
    const view = project(native, [], session)
    assert.equal(view.messages.length, 0, "unselectable messages must not receive DCP IDs")
    assert.deepEqual(view.restore(), native)
})

test("V2 inserts summaries after native checkpoints without an ordinary user message", () => {
    const native = transcript().filter((message) => message.role !== "user")
    const view = project(native, entries(native), session)
    const state = createSessionState("compact")
    state.prune.messages.byMessageId.set("msg_assistant", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.activeByAnchorMessageId.set("msg_assistant", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
        anchorMessageId: "msg_assistant",
        summary: "CHECKPOINT_SUMMARY",
    } as CompressionBlock)
    prune(state, logger, config, view.messages, view.summaryBase)
    const restored = view.restore()
    assert.equal(restored.length, 2)
    assert.deepEqual(restored[0], native[0])
    assert.deepEqual(restored[1]?.content, [{ type: "text", text: "CHECKPOINT_SUMMARY" }])
})
