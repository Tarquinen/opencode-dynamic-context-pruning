/* Throwaway benchmark: replays the real long session through DCP's transform
 * hot path (syncToolCache + prune) to measure main-thread blocking time.
 * Run: node --import tsx scripts/bench-longsession.mts <fixture.json>
 */
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import type { WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { syncToolCache } from "../lib/state/tool-cache"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import { countTokens } from "../lib/token-utils"

const fixturePath = process.argv[2] ?? "C:/Users/21288/AppData/Local/Temp/opencode/longsession.json"

function buildConfig(): PluginConfig {
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
            contextAccounting: false,
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

console.log("fixture messages:", messages.length)
console.log(
    "tool parts:",
    messages.reduce((acc, m) => acc + m.parts.filter((p) => p.type === "tool").length, 0),
)
const totalChars = messages.reduce((acc, m) => {
    let sum = 0
    for (const p of m.parts) {
        if (p.type === "text" && typeof p.text === "string") sum += p.text.length
        if (p.type === "tool") {
            if (typeof p.state?.input === "string") sum += p.state.input.length
            if (typeof p.state?.output === "string") sum += p.state.output.length
        }
    }
    return acc + sum
}, 0)
console.log("approx content chars:", totalChars.toLocaleString())

// Sanity: tokenizer works and is fast
const t0 = performance.now()
let sanity = 0
for (let i = 0; i < 10; i++) sanity += countTokens("word ".repeat(500))
const t1 = performance.now()
console.log(`sanity 10x countTokens: ${(t1 - t0).toFixed(1)}ms (result ${sanity})`)

// Timing syncToolCache over full message list (fresh state => full pass)
const state = createSessionState()
state.sessionId = fixture.session_id
const logger = new Logger(false)
const config = buildConfig()

const t2 = performance.now()
syncToolCache(state, config, logger, messages)
const t3 = performance.now()
console.log(
    `syncToolCache full pass: ${(t3 - t2).toFixed(1)}ms (toolParameters.size=${state.toolParameters.size})`,
)

// Timing a second pass (cache hit => should be ~0)
const t4 = performance.now()
syncToolCache(state, config, logger, messages)
const t5 = performance.now()
console.log(`syncToolCache cache-hit pass: ${(t5 - t4).toFixed(1)}ms`)

const t6 = performance.now()
const totalTokens = Array.from(state.toolParameters.values()).reduce(
    (acc, e) => acc + (e.tokenCount ?? 0),
    0,
)
const t7 = performance.now()
console.log(`sum tokenCounts: ${totalTokens} (${(t7 - t6).toFixed(1)}ms)`)
