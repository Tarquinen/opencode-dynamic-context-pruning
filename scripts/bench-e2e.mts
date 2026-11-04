/* End-to-end transform benchmark over the real long session with the FIXED code.
 * Run: node --import tsx scripts/bench-e2e.mts <fixture.json>
 */
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import type { WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { resetSharedTokenizerForTests } from "../lib/token-utils"

const fixturePath = process.argv[2] ?? "C:/Users/21288/AppData/Local/Temp/opencode/longsession.json"

function buildConfig(contextAccounting: boolean): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
            contextAccounting,
            recoverInherited: false,
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
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function toWithParts(fixture: any): WithParts[] {
    const sessionID = fixture.session_id
    return fixture.messages.map((m: any) => {
        const role = m.data?.role ?? "user"
        const info: any = {
            id: m.id,
            role,
            sessionID,
            time: { created: m.time_created },
        }
        if (m.data?.agent) info.agent = m.data.agent
        if (m.data?.summary) info.summary = true
        if (m.data?.tokens) info.tokens = m.data.tokens
        if (role === "user" && m.data?.model) info.model = m.data.model
        const parts = (m.parts ?? []).map((pt: any) => {
            const part: any = { ...pt }
            if (part.type === "tool") {
                part.state = pt.state ?? {}
            }
            return part
        })
        return { info, parts }
    })
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"))
const messages = toWithParts(fixture)

function promptStore() {
    return {
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
    }
}

async function runOnce(contextAccounting: boolean, label: string): Promise<void> {
    resetSharedTokenizerForTests()
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig(contextAccounting)
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        config,
        promptStore() as any,
        { global: undefined, agents: {} },
    )
    const start = performance.now()
    await handler({}, { messages: [...messages] })
    const elapsed = performance.now() - start
    console.log(
        `${label}: ${elapsed.toFixed(1)}ms (snapshot=${state.lastContextSnapshot ? "yes" : "no"})`,
    )
}

async function main() {
    console.log("fixture messages:", messages.length)
    await runOnce(false, "transform accounting=off (fix)")
    await runOnce(true, "transform accounting=on ")
    await runOnce(false, "transform accounting=off (2nd)")
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
