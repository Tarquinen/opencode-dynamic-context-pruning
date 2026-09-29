import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { stateDir } from "./lab/persistence-env"
import { createCompressMessageTool } from "../lib/compress/message"
import {
    createSessionState,
    ensureSessionInitialized,
    checkSession,
    syncToolCache,
    type WithParts,
} from "../lib/state"
import { loadSessionState, saveManualModeSetting, saveSessionState } from "../lib/state/persistence"
import { syncCompressionBlocks, prune, buildToolIdList } from "../lib/messages"
import { deduplicate } from "../lib/strategies"
import { assignMessageRefs } from "../lib/message-ids"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

// XDG sandbox is set up by ./lab/persistence-env (imported first on purpose).

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
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
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
    input: Record<string, unknown> = { description: "demo" },
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
            input,
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
                model: { providerID: "anthropic", modelID: "claude-test" },
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

function buildClient(rawMessages: WithParts[]) {
    return {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
        },
    }
}

function promptsMock() {
    return {
        reload() {},
        getRuntimePrompts() {
            return { compressMessage: "", compressRange: "" }
        },
    }
}

function readStateFile(sessionID: string): Record<string, any> {
    return JSON.parse(readFileSync(join(stateDir, `${sessionID}.json`), "utf-8"))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("compress blocks are written through to disk by the tool exec and reload after restart", async () => {
    const sessionID = `ses_persist_write_through_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const logger = new Logger(false)
    const config = buildConfig()
    const client = buildClient(rawMessages)

    // Mirrors the V2 tool path: load() binds and hydrates the state BEFORE exec.
    const state = createSessionState()
    await ensureSessionInitialized(client, state, sessionID, logger, rawMessages, false)
    assert.equal(state.sessionId, sessionID)

    const tool = createCompressMessageTool({ client, state, logger, config, prompts: promptsMock() } as any)
    const result = await tool.execute(
        {
            topic: "Persist regression",
            content: [
                {
                    messageId: "m0002",
                    topic: "Code path note",
                    summary: "Captured the assistant's code-path findings.",
                },
                {
                    messageId: "m0003",
                    topic: "Task output note",
                    summary: "Captured the assistant's task-backed follow-up.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-assistant-2",
        },
    )

    assert.match(result, /Compressed 2 messages/)
    assert.equal(state.prune.messages.blocksById.size, 2)

    // Write-through: the file on disk already holds the blocks WITHOUT any
    // additional explicit save (the exec's finalizeSession did it).
    const persisted = readStateFile(sessionID)
    assert.equal(Object.keys(persisted.prune.messages.blocksById).length, 2)
    assert.equal(persisted.prune.messages.nextRunId, 2)

    // Restart simulation: a brand-new state must re-bind from the file name
    // and restore blocks from disk.
    const reloaded = createSessionState()
    await ensureSessionInitialized(client, reloaded, sessionID, logger, rawMessages, false)
    assert.equal(reloaded.sessionId, sessionID)
    assert.equal(reloaded.prune.messages.blocksById.size, 2)
    assert.equal(reloaded.prune.messages.activeBlockIds.size, 2)
    assert.equal(reloaded.prune.messages.nextRunId, 2)
})

test("blocks stay active when the request window rolls past their origin message", async () => {
    const sessionID = `ses_window_roll_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const logger = new Logger(false)
    const config = buildConfig()
    const client = buildClient(rawMessages)

    const state = createSessionState()
    await ensureSessionInitialized(client, state, sessionID, logger, rawMessages, false)

    const tool = createCompressMessageTool({ client, state, logger, config, prompts: promptsMock() } as any)
    await tool.execute(
        {
            topic: "Window roll",
            content: [
                {
                    messageId: "m0002",
                    topic: "Note",
                    summary: "Summary of the compressed range.",
                },
            ],
        },
        { ask: async () => {}, metadata: () => {}, sessionID, messageID: "msg-assistant-2" },
    )
    assert.equal(state.prune.messages.blocksById.size, 1)

    // Simulate a rolled/truncated request window: the compress-bearing
    // assistant message (the block origin) is no longer visible.
    const rolledWindow = rawMessages.filter((msg) => msg.info.id !== "msg-assistant-2")
    const changed = syncCompressionBlocks(state, logger, rolledWindow)
    assert.equal(changed, false)
    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.equal(block.active, true, "block must survive window truncation")
    assert.equal(state.prune.messages.activeBlockIds.size, 1)
})

test("filterCompressedRanges applies reloaded blocks against re-fetched messages", async () => {
    const sessionID = `ses_reload_filter_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const logger = new Logger(false)
    const config = buildConfig()
    const client = buildClient(rawMessages)

    const state = createSessionState()
    await ensureSessionInitialized(client, state, sessionID, logger, rawMessages, false)
    const tool = createCompressMessageTool({ client, state, logger, config, prompts: promptsMock() } as any)
    await tool.execute(
        {
            topic: "Reload filter",
            content: [
                {
                    messageId: "m0002",
                    topic: "Note",
                    summary: "Summary of the compressed range.",
                },
            ],
        },
        { ask: async () => {}, metadata: () => {}, sessionID, messageID: "msg-assistant-2" },
    )

    // Restart + re-fetch the same history, then run the request-time prune.
    const reloaded = createSessionState()
    await ensureSessionInitialized(client, reloaded, sessionID, logger, rawMessages, false)
    const requestMessages = buildMessages(sessionID)
    prune(reloaded, logger, config, requestMessages)

    const ids = requestMessages.map((msg) => msg.info.id)
    assert.ok(!ids.includes("msg-assistant-1"), "compressed message must be filtered out")
    const serialized = JSON.stringify(requestMessages)
    assert.match(serialized, /Summary of the compressed range\./)
})

test("duplicate tool outputs are marked for pruning on the request path and persist", async () => {
    const sessionID = `ses_prune_tools_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    // Same tool + same input twice: deduplication must mark the older call.
    rawMessages.push({
        info: {
            id: "msg-assistant-3",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 4 },
        } as WithParts["info"],
        parts: [
            toolPart("msg-assistant-3", sessionID, "call-task-2", "task", "task output body"),
        ],
    })

    const logger = new Logger(false)
    const config = buildConfig()
    const client = buildClient(rawMessages)

    const state = createSessionState()
    await ensureSessionInitialized(client, state, sessionID, logger, rawMessages, false)
    assignMessageRefs(state, rawMessages)
    syncToolCache(state, config, logger, rawMessages)
    buildToolIdList(state, rawMessages)
    deduplicate(state, logger, config, rawMessages)

    assert.equal(state.prune.tools.size, 1, "deduplication must mark the superseded call")
    assert.ok(state.prune.tools.has("call-task-1"))

    prune(state, logger, config, rawMessages)
    const superseded = rawMessages
        .flatMap((msg) => msg.parts)
        .find((part: any) => part.callID === "call-task-1")
    assert.ok(superseded, "superseded tool part must still exist")
    assert.equal(
        (superseded as any).state?.output,
        "[Output removed to save context - information superseded or no longer needed]",
    )

    await saveSessionState(state, logger)

    const persisted = readStateFile(sessionID)
    assert.equal(Object.keys(persisted.prune.tools).length, 1)

    const reloaded = createSessionState()
    await ensureSessionInitialized(client, reloaded, sessionID, logger, rawMessages, false)
    assert.equal(reloaded.prune.tools.size, 1)
    assert.ok(reloaded.prune.tools.has("call-task-1"))
})

test("manual mode setting survives a restart via the persisted state", async () => {
    const sessionID = `ses_manual_mode_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const logger = new Logger(false)
    const client = buildClient(rawMessages)

    await saveManualModeSetting(sessionID, true, logger)

    const state = createSessionState()
    await ensureSessionInitialized(client, state, sessionID, logger, rawMessages, true)
    assert.equal(state.manualMode, "active")

    const persisted = await loadSessionState(sessionID, logger)
    assert.equal(persisted?.manualMode, true)
})

test("manual mode save refuses to overwrite an unreadable state file", async () => {
    const sessionID = `ses_manual_guard_${Date.now()}`
    const stateFile = join(stateDir, `${sessionID}.json`)
    const garbage = "{ this is not valid json"
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(stateFile, garbage, "utf-8")
    const logger = new Logger(false)

    await saveManualModeSetting(sessionID, true, logger)

    assert.equal(
        readFileSync(stateFile, "utf-8"),
        garbage,
        "manual-mode save must not destroy the unreadable file",
    )
})

test("a real compaction summary still resets prune state by design", async () => {
    const sessionID = `ses_compaction_reset_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const logger = new Logger(false)
    const config = buildConfig()
    const client = buildClient(rawMessages)

    const state = createSessionState()
    await ensureSessionInitialized(client, state, sessionID, logger, rawMessages, false)
    const tool = createCompressMessageTool({ client, state, logger, config, prompts: promptsMock() } as any)
    await tool.execute(
        {
            topic: "Before compaction",
            content: [
                { messageId: "m0002", topic: "Note", summary: "Pre-compaction summary." },
            ],
        },
        { ask: async () => {}, metadata: () => {}, sessionID, messageID: "msg-assistant-2" },
    )
    assert.equal(state.prune.messages.blocksById.size, 1)

    // The host appends a compaction summary message to the same session.
    rawMessages.push({
        info: {
            id: "msg-summary-1",
            role: "assistant",
            sessionID,
            agent: "assistant",
            summary: true,
            time: { created: 9999 },
        } as WithParts["info"],
        parts: [],
    })

    await checkSession(client, state, logger, rawMessages, false)
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.prune.messages.nextRunId, 1)

    // The reset is persisted (fire-and-forget save inside checkSession).
    await sleep(50)
    const persisted = readStateFile(sessionID)
    assert.equal(Object.keys(persisted.prune.messages.blocksById).length, 0)
})
