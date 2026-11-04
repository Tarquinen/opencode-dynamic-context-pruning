/**
 * Offline "gray test" harness for DCP.
 *
 * Replays a real session through the plugin's actual transform pipeline
 * (assignMessageRefs -> syncCompressionBlocks -> prune -> guidance) WITHOUT
 * starting opencode and WITHOUT touching the deployed plugin cache. Use it to
 * see exactly what the model would receive and how much context the current
 * build would reclaim.
 *
 * Usage:
 *   npx tsx scripts/gray-replay.mts [sessionId]
 */
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSessionState } from "../lib/state/state"
import { loadPruneMessagesState, getActiveSummaryTokenUsage } from "../lib/state/utils"
import { assignMessageRefs } from "../lib/message-ids"
import { prune } from "../lib/messages/prune"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { Logger } from "../lib/logger"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { countAllMessageTokens } from "../lib/token-utils"
import type { WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"

const sessionId = process.argv[2] ?? "ses_f4a95ea3affee6tcF7r8FZaChq"
const dataHome = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "opencode")
    : path.join(os.homedir(), ".local", "share", "opencode")
const configHome = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode")
const stateFile = path.join(dataHome, "storage", "plugin", "dcp", `${sessionId}.json`)
const dbPath = path.join(dataHome, "opencode.db")

if (!fs.existsSync(stateFile)) {
    console.error(`DCP state not found: ${stateFile}`)
    process.exit(1)
}
if (!fs.existsSync(dbPath)) {
    console.error(`opencode DB not found: ${dbPath}`)
    process.exit(1)
}

function readDcpConfig(): any {
    for (const name of ["dcp.jsonc", "dcp.json"]) {
        const p = path.join(configHome, name)
        if (fs.existsSync(p)) {
            try {
                const raw = fs
                    .readFileSync(p, "utf-8")
                    .replace(/\/\*[\s\S]*?\*\//g, "")
                    .replace(/(^|[^:])\/\/.*$/gm, "$1")
                return JSON.parse(raw)
            } catch {
                return {}
            }
        }
    }
    return {}
}

const dcp = readDcpConfig()
const config = {
    compress: {
        mode: dcp?.compress?.mode ?? "range",
        recursiveCondense: dcp?.compress?.recursiveCondense ?? false,
        maxContextLimit: dcp?.compress?.maxContextLimit ?? "80%",
        minContextLimit: dcp?.compress?.minContextLimit ?? "65%",
    },
} as unknown as PluginConfig

const logger = new Logger(false)
const state = createSessionState()
state.sessionId = sessionId

const persisted = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
state.stats = persisted.stats ?? state.stats
state.lastCompaction = persisted.lastCompaction ?? 0
state.lastDcpCompression = persisted.lastDcpCompression ?? 0

const db = new DatabaseSync(dbPath)
const messageRows = db
    .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created")
    .all(sessionId) as Array<{ id: string; data: string }>
const partRows = db
    .prepare("SELECT message_id, data FROM part WHERE session_id = ?")
    .all(sessionId) as Array<{ message_id: string; data: string }>

const partsByMessage = new Map<string, any[]>()
for (const row of partRows) {
    let parsed: any
    try {
        parsed = JSON.parse(row.data)
    } catch {
        continue
    }
    const list = partsByMessage.get(row.message_id) ?? []
    list.push(parsed)
    partsByMessage.set(row.message_id, list)
}

const messages: WithParts[] = messageRows.map((row) => {
    const info = JSON.parse(row.data)
    return {
        info: {
            id: row.id,
            role: info.role,
            sessionID: sessionId,
            time: info.time ?? { created: 0 },
            ...(info.role === "user"
                ? { model: info.model ?? { providerID: "unknown", modelID: "unknown" } }
                : {}),
        },
        parts: partsByMessage.get(row.id) ?? [],
    } as WithParts
})

assignMessageRefs(state, messages)
syncCompressionBlocks(state, logger, messages)

const rawTokens = messages.reduce((sum, m) => sum + countAllMessageTokens(m), 0)

const beforeIds = new Set(messages.map((m) => m.info.id))
prune(state, logger, config, messages)
const afterIds = new Set(messages.map((m) => m.info.id))
const removed = [...beforeIds].filter((id) => !afterIds.has(id))
const transformedTokens =
    messages.reduce((sum, m) => sum + countAllMessageTokens(m), 0) +
    getActiveSummaryTokenUsage(state)

const guidance = buildCompressedBlockGuidance(state, messages)

const line = "─".repeat(72)
console.log(line)
console.log(`DCP gray replay (offline)  session=${sessionId}`)
console.log(line)
console.log(`raw messages:          ${messageRows.length}`)
console.log(`raw tokens (est):      ${rawTokens.toLocaleString()}`)
console.log(`transformed messages:  ${messages.length}  (removed ${removed.length})`)
console.log(
    `transformed tokens:    ${transformedTokens.toLocaleString()}  (incl. active summaries)`,
)
console.log(`active blocks:         ${state.prune.messages.activeBlockIds.size}`)
console.log(`active summary tokens: ${getActiveSummaryTokenUsage(state).toLocaleString()}`)
console.log(
    `config:                recursiveCondense=${config.compress.recursiveCondense} max=${config.compress.maxContextLimit} min=${config.compress.minContextLimit} mode=${config.compress.mode}`,
)
console.log(line)
console.log("Guidance the model would receive in a nudge:")
console.log(guidance || "(none)")
console.log(line)
console.log("First 6 messages still visible to the model:")
for (const m of messages.slice(0, 6)) {
    const ref = state.messageIds.byRawId.get(m.info.id) ?? "?"
    const chars = m.parts.reduce((n: number, p: any) => {
        if (p?.type === "text") return n + (p.text?.length ?? 0)
        if (p?.type === "tool") {
            return (
                n +
                (typeof p.state?.output === "string" ? p.state.output.length : 0) +
                (p.state?.input ? JSON.stringify(p.state.input).length : 0)
            )
        }
        return n
    }, 0)
    console.log(`  ${ref}  ${m.info.role}  ~${chars} chars`)
}
