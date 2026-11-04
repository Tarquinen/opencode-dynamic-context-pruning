import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"
import {
    collectCompressCallRecords,
    isCompressCallApplied,
    replayCompletedCompressions,
} from "../lib/state/recovery"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-recovery-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-recovery-config-${process.pid}`)

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
            allowSubAgents: false,
            contextAccounting: false,
            recoverInherited: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            pollCooldown: 3,
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            recursiveCondense: false,
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

function compressToolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    topic: string,
    content: Array<{ startId: string; endId: string; summary: string }>,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: "compress",
        callID,
        state: {
            status: "completed" as const,
            input: { topic, content },
        },
    }
}

/**
 * Models a forked session: the child inherited the parent's raw messages
 * (which contain completed compress tool parts from the parent's history) but
 * the DCP state was not migrated, so the inherited prefix is uncovered.
 */
function buildForkMessages(sessionID: string): WithParts[] {
    const inheritedMessages: WithParts[] = [
        {
            info: {
                id: "msg-inherited-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 100 },
            } as WithParts["info"],
            parts: [
                textPart("msg-inherited-1", sessionID, "p1", "Large read output here"),
                {
                    id: "p1-tool",
                    messageID: "msg-inherited-1",
                    sessionID,
                    type: "tool" as const,
                    tool: "read",
                    callID: "call-read-1",
                    state: {
                        status: "completed" as const,
                        input: { filePath: "big.ts" },
                        output: "A".repeat(8000),
                    },
                },
            ],
        },
        {
            info: {
                id: "msg-inherited-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 200 },
            } as WithParts["info"],
            parts: [textPart("msg-inherited-2", sessionID, "p2", "Summarizing the layout")],
        },
        {
            info: {
                id: "msg-inherited-3",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 300 },
            } as WithParts["info"],
            parts: [textPart("msg-inherited-3", sessionID, "p3", "Continue investigating")],
        },
        {
            info: {
                id: "msg-parent-compress",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 400 },
            } as WithParts["info"],
            parts: [
                compressToolPart(
                    "msg-parent-compress",
                    sessionID,
                    "call-parent-compress",
                    "Fork prefix",
                    [
                        {
                            startId: "m0001",
                            endId: "m0002",
                            summary:
                                "Captured the inherited read output and the assistant layout summary.",
                        },
                    ],
                ),
            ],
        },
    ]

    // The child then continues with its own messages AFTER the fork point.
    const childMessages: WithParts[] = [
        {
            info: {
                id: "msg-child-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 500 },
            } as WithParts["info"],
            parts: [textPart("msg-child-1", sessionID, "p4", "Now let us look at the new code")],
        },
        {
            info: {
                id: "msg-child-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 600 },
            } as WithParts["info"],
            parts: [textPart("msg-child-2", sessionID, "p5", "Found the relevant module")],
        },
    ]

    return [...inheritedMessages, ...childMessages]
}

test("collectCompressCallRecords extracts completed compress tool parts", () => {
    const sessionID = "ses_recovery_collect"
    const messages = buildForkMessages(sessionID)
    const records = collectCompressCallRecords(messages)

    assert.equal(records.length, 1)
    assert.equal(records[0]?.callId, "call-parent-compress")
    assert.equal(records[0]?.messageId, "msg-parent-compress")
})

test("replay rebuilds blocks for inherited compress history and covers the prefix", async () => {
    const sessionID = `ses_recovery_replay_${Date.now()}`
    const messages = buildForkMessages(sessionID)
    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)
    const config = buildConfig()

    const result = await replayCompletedCompressions(
        {
            session: {
                messages: async () => ({ data: messages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        messages,
    )

    assert.equal(result.recovered, 1)
    assert.equal(result.skipped, 0)
    assert.equal(state.prune.messages.blocksById.size, 1)

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block, "block b1 should exist")
    assert.equal(block.active, true)
    assert.equal(block.compressCallId, "call-parent-compress")
    assert.ok(block.effectiveMessageIds.includes("msg-inherited-1"))
    assert.ok(block.effectiveMessageIds.includes("msg-inherited-2"))
    assert.match(block.summary || "", /\[Compressed conversation section\]/)
    assert.match(block.summary || "", /inherited read output/)

    // The inherited messages are now covered (active block)
    const entry1 = state.prune.messages.byMessageId.get("msg-inherited-1")
    assert.ok(entry1 && entry1.activeBlockIds.includes(1))
})

test("replay is idempotent: already-applied compress calls are skipped", async () => {
    const sessionID = `ses_recovery_idempotent_${Date.now()}`
    const messages = buildForkMessages(sessionID)
    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)
    const config = buildConfig()

    await replayCompletedCompressions({ session: {} }, state, logger, config, messages)
    const second = await replayCompletedCompressions(
        { session: {} },
        state,
        logger,
        config,
        messages,
    )

    assert.equal(second.recovered, 0)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("isCompressCallApplied returns true once a block owns the call id", () => {
    const sessionID = "ses_recovery_applied"
    const messages = buildForkMessages(sessionID)
    const state = createSessionState()
    state.sessionId = sessionID

    assert.equal(isCompressCallApplied(state, "call-parent-compress"), false)
    state.prune.messages.blocksById.set(5, {
        blockId: 5,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 10,
        durationMs: 0,
        mode: "range",
        topic: "x",
        batchTopic: "x",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "msg-inherited-1",
        compressMessageId: "msg-parent-compress",
        compressCallId: "call-parent-compress",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "x",
    })
    assert.equal(isCompressCallApplied(state, "call-parent-compress"), true)
})

test("replay skips stale mNNNN references with a warning and does not abort", async () => {
    const sessionID = `ses_recovery_stale_${Date.now()}`
    const messages = buildForkMessages(sessionID)

    // Add a compress call referencing a message that does not exist in the fork.
    const staleMessage: WithParts = {
        info: {
            id: "msg-parent-compress-stale",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 450 },
        } as WithParts["info"],
        parts: [
            compressToolPart("msg-parent-compress-stale", sessionID, "call-stale", "Stale", [
                {
                    startId: "m0045",
                    endId: "m0046",
                    summary: "References messages that were folded away in the parent.",
                },
            ]),
        ],
    }
    messages.splice(4, 0, staleMessage)

    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)
    const config = buildConfig()

    const result = await replayCompletedCompressions(
        {
            session: {
                messages: async () => ({ data: messages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        messages,
    )

    // One valid call replayed; stale call skipped with a warning.
    assert.equal(result.recovered, 1)
    assert.equal(result.skipped, 1)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] || "", /call-stale/)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("recovery integrates with ensureSessionInitialized when no persisted state exists", async () => {
    const sessionID = `ses_recovery_integrate_${Date.now()}`
    const messages = buildForkMessages(sessionID)

    // Clean any stale persisted state for this session id.
    const stateFile = join(
        testDataHome,
        "opencode",
        "storage",
        "plugin",
        "dcp",
        `${sessionID}.json`,
    )
    try {
        rmSync(stateFile, { force: true })
    } catch {
        // ignore
    }

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.experimental.recoverInherited = true

    const { ensureSessionInitialized } = await import("../lib/state/state")
    await ensureSessionInitialized(
        {
            session: {
                get: async () => ({ data: { parentID: null } }),
                messages: async () => ({ data: messages }),
            },
        },
        state,
        sessionID,
        logger,
        messages,
        config.manualMode.enabled,
        config,
    )

    assert.equal(state.sessionId, sessionID)
    assert.ok(state.prune.messages.blocksById.size >= 1)
    assert.match(state.prune.messages.blocksById.get(1)?.summary || "", /inherited read output/)
})
