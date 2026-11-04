import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { createSessionState, type WithParts } from "../lib/state"

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

function buildMessages(sessionID: string, text: string): WithParts[] {
    const id = `msg-${sessionID}`
    return [
        {
            info: {
                id,
                role: "user",
                sessionID,
                agent: "build",
                time: { created: 1 },
                model: { providerID: "deepseek", modelID: "deepseek-flash" },
            } as WithParts["info"],
            parts: [
                {
                    id: `${id}-part`,
                    messageID: id,
                    sessionID,
                    type: "text",
                    text,
                } as any,
            ],
        } as WithParts,
    ]
}

function buildPromptStore() {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "DCP-RUNTIME-PROMPT",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    } as any
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("concurrent transforms from different sessions never borrow another session's state", async () => {
    const state = createSessionState()
    const records: Array<{ saved: string; actual: string }> = []
    const logger = {
        info() {},
        debug() {},
        warn() {},
        error() {},
        async saveContext(sessionId: string, messages: WithParts[]) {
            const actual = messages[messages.length - 1]?.info?.sessionID ?? "?"
            records.push({ saved: sessionId, actual })
            await delay(1)
        },
    } as any

    const client = {
        session: {
            get: async ({ path }: any) => {
                await delay(path.id === "sub" ? 5 : 60)
                return { data: path.id === "sub" ? { parentID: "main" } : {} }
            },
        },
    }

    const handler = createChatMessageTransformHandler(
        client,
        state,
        logger,
        buildConfig(),
        buildPromptStore(),
        { global: undefined, agents: {} } as any,
    )

    const mainOutput = { messages: buildMessages("main", "main session user message") }
    const subOutput = { messages: buildMessages("sub", "subagent session user message") }

    await Promise.all([handler({}, mainOutput), handler({}, subOutput)])

    assert.equal(records.length, 1)
    assert.equal(records[0].saved, "main")
    assert.equal(records[0].actual, "main")
})
