import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { countTokens } from "../lib/token-utils"

const testDataHome = join(tmpdir(), `opencode-dcp-perf-guard-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-perf-config-${process.pid}`)

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
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "p1", "hello")],
        },
        {
            info: {
                id: "msg-asst-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-asst-1", sessionID, "p2", "ok")],
        },
    ]
}

async function runTransform(
    config: PluginConfig,
    messages: WithParts[],
): Promise<{ state: ReturnType<typeof createSessionState> }> {
    const state = createSessionState()
    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {
                    system: "",
                    compressRange: "",
                    compressMessage: "",
                    contextLimitNudge: "context-limit-nudge",
                    turnNudge: "turn-nudge",
                    iterationNudge: "iteration-nudge",
                    manualExtension: "",
                    subagentExtension: "",
                }
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = { messages: [...messages] }
    await handler({}, output)
    return { state }
}

test("transform does not compute a context accounting snapshot by default", async () => {
    const { state } = await runTransform(buildConfig(), buildMessages("ses_perf_guard_1"))
    assert.equal(state.lastContextSnapshot, undefined)
})

test("transform computes a context accounting snapshot only when explicitly enabled", async () => {
    const config = buildConfig()
    config.experimental = {
        allowSubAgents: false,
        customPrompts: false,
        contextAccounting: true,
        recoverInherited: false,
    }
    const { state } = await runTransform(config, buildMessages("ses_perf_guard_2"))
    assert.ok(state.lastContextSnapshot, "snapshot should be present when enabled")
    assert.equal(state.lastContextSnapshot.rawMessageCount, 2)
})

test("countTokens stays correct and consistent across many repeated calls", () => {
    const text = "export const countTokens = (text: string): number => text.length"
    const first = countTokens(text)
    for (let i = 0; i < 50; i++) {
        assert.equal(countTokens(text), first)
    }
    assert.ok(first > 0)
})

test("countTokens handles empty and large strings without throwing", () => {
    assert.equal(countTokens(""), 0)
    const large = "word ".repeat(5000)
    const counted = countTokens(large)
    assert.ok(counted > 1000)
    assert.ok(counted < large.length)
})
