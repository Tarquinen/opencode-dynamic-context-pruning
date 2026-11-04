import assert from "node:assert/strict"
import test from "node:test"
import { finalizeSession } from "../lib/compress/pipeline"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    loadManualModeSetting,
    saveManualModeSetting,
    type WithParts,
} from "../lib/state"

function buildConfig(manualMode = false): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: manualMode, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: {
            allowSubAgents: false,
            contextAccounting: false,
            recoverInherited: false,
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
            pollCooldown: 3,
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    } as PluginConfig
}

function buildToolContext(state: ReturnType<typeof createSessionState>, manualMode = false) {
    return {
        client: { session: { get: async () => ({}) } },
        state,
        logger: new Logger(false),
        config: buildConfig(manualMode),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        },
    }
}

test("finalizeSession resets compress-pending to auto mode", async () => {
    const sessionId = `finalize-compress-pending-${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionId
    state.manualMode = "compress-pending"

    await finalizeSession(
        buildToolContext(state) as any,
        { sessionID: sessionId, metadata: () => {}, ask: async () => {} },
        [] as WithParts[],
        [],
        undefined,
    )

    assert.equal(state.manualMode, false)

    const persisted = await loadManualModeSetting(sessionId, new Logger(false))
    assert.equal(persisted, false)
})

test("finalizeSession restores persisted manual mode after compression", async () => {
    const sessionId = `finalize-persisted-manual-${Date.now()}`
    const logger = new Logger(false)
    await saveManualModeSetting(sessionId, true, logger)

    const state = createSessionState()
    state.sessionId = sessionId
    state.manualMode = "compress-pending"

    await finalizeSession(
        buildToolContext(state) as any,
        { sessionID: sessionId, metadata: () => {}, ask: async () => {} },
        [] as WithParts[],
        [],
        undefined,
    )

    assert.equal(state.manualMode, "active")

    const persisted = await loadManualModeSetting(sessionId, logger)
    assert.equal(persisted, true)
})

test("finalizeSession restores configured manual mode after compression", async () => {
    const sessionId = `finalize-configured-manual-${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionId
    state.manualMode = "compress-pending"

    await finalizeSession(
        buildToolContext(state, true) as any,
        { sessionID: sessionId, metadata: () => {}, ask: async () => {} },
        [] as WithParts[],
        [],
        undefined,
    )

    assert.equal(state.manualMode, "active")

    const persisted = await loadManualModeSetting(sessionId, new Logger(false))
    assert.equal(persisted, true)
})
