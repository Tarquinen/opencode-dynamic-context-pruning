// The built legacy server entrypoint (dist/index.js, as published) with real tokenizer
// children: count failures apply no compression blocks, manual mode is rechecked after
// approval, and hooks sharing state wait for an awaited count. Requires `npm run build`.
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "dcp-legacy-entrypoint-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const entrypoint = new URL("../dist/index.js", import.meta.url)
const built = existsSync(entrypoint)
const plugin: any = built ? (await import(entrypoint.href)).default : undefined
const skip = !built && "dist/index.js is not built"

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function messages(sessionID: string) {
    return [1, 2, 3].map((n) => ({
        info: {
            id: `msg-${n}`,
            role: n === 2 ? "assistant" : "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "synthetic", modelID: "fixture" },
            time: { created: n },
        },
        parts: [
            {
                id: `part-${n}`,
                type: "text",
                text: `message ${n}`,
                sessionID,
                messageID: `msg-${n}`,
            },
        ],
    })) as any[]
}

function storedBlocks(sessionID: string): string[] {
    const path = join(root, "data", "opencode/storage/plugin/dcp", `${sessionID}.json`)
    if (!existsSync(path)) return []
    return Object.keys(JSON.parse(readFileSync(path, "utf8")).prune.messages.blocksById ?? {})
}

async function server(mode: "range" | "message") {
    const directory = join(root, `project-${mode}`)
    mkdirSync(join(directory, ".opencode"), { recursive: true })
    writeFileSync(
        join(directory, ".opencode", "dcp.jsonc"),
        JSON.stringify({
            autoUpdate: false,
            pruneNotification: "off",
            compress: { mode, permission: "allow", protectUserMessages: false, protectTags: false },
            strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
        }),
    )
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async ({ path }: any) => ({ data: messages(path.id) }),
            prompt: async () => ({}),
        },
        tui: { showToast: async () => ({}) },
    }
    const hooks = await plugin.server({ directory, client })
    const content = (summaries: string[]) =>
        summaries.map((summary, i) =>
            mode === "range"
                ? { startId: `m000${i + 1}`, endId: `m000${i + 1}`, summary }
                : { messageId: `m000${i + 1}`, topic: `part-${i}`, summary },
        )
    const toolContext = (sessionID: string) => ({
        sessionID,
        messageID: "msg-compress",
        ask: async () => {},
        metadata() {},
    })
    return { hooks, content, toolContext }
}

for (const mode of ["range", "message"] as const) {
    test(
        `built ${mode} compression applies no blocks when a later summary cannot be counted`,
        { skip },
        async () => {
            const { hooks, content, toolContext } = await server(mode)
            const sessionID = `ses_entry_atomic_${mode}`
            await hooks["experimental.chat.messages.transform"](
                {},
                { messages: messages(sessionID) },
            )
            await assert.rejects(
                hooks.tool.compress.execute(
                    {
                        topic: "atomic",
                        content: content(["first summary", "x".repeat(8 * 1024 * 1024 + 1)]),
                    },
                    toolContext(sessionID),
                ),
                { name: "TokenCountError", code: "too_large" },
            )
            assert.deepEqual(storedBlocks(sessionID), [])
            await hooks.tool.compress.execute(
                { topic: "ok", content: content(["Summary Ｈｅｌｌｏ ﬁ ① 👩‍👩‍👧‍👦 日本語."]) },
                toolContext(sessionID),
            )
            assert.deepEqual(storedBlocks(sessionID), ["1"])
        },
    )

    test(`built ${mode} compression rechecks manual mode after approval`, { skip }, async () => {
        const { hooks, content, toolContext } = await server(mode)
        const sessionID = `ses_entry_manual_${mode}`
        await hooks["experimental.chat.messages.transform"]({}, { messages: messages(sessionID) })
        let asked = () => {}
        let approve = () => {}
        const asking = new Promise<void>((resolve) => (asked = resolve))
        const approval = new Promise<void>((resolve) => (approve = resolve))
        const pending = hooks.tool.compress.execute(
            { topic: "approval", content: content(["summary"]) },
            {
                ...toolContext(sessionID),
                ask: async () => {
                    asked()
                    await approval
                },
            },
        )
        await asking
        // The command completes while approval waits: the permission prompt holds no lock.
        await hooks["command.execute.before"](
            { command: "dcp", sessionID, arguments: "manual on" },
            { parts: [] },
        )
        approve()
        await assert.rejects(pending, /Manual mode: compress blocked/)
        assert.deepEqual(storedBlocks(sessionID), [])
    })
}

test(
    "built hooks sharing state wait for a slow count, which times out without blocking",
    { skip },
    async () => {
        const { hooks } = await server("range")
        const sessionID = "ses_entry_slow"
        const slow = messages(sessionID)
        slow[1].parts = [
            {
                id: "tool-part",
                messageID: "msg-2",
                sessionID,
                type: "tool",
                tool: "read",
                callID: "slow-tool",
                state: { status: "completed", input: {}, output: "a".repeat(500_000) },
            },
        ]
        const other = "ses_entry_other"
        let gap = 0
        let last = performance.now()
        const heartbeat = setInterval(() => {
            const now = performance.now()
            gap = Math.max(gap, now - last)
            last = now
        }, 25)
        try {
            const rejected = assert.rejects(
                hooks["experimental.chat.messages.transform"]({}, { messages: slow }),
                { name: "TokenCountError", code: "timeout" },
            )
            await pause(200)
            let systemDone = false
            let commandDone = false
            const system = hooks["experimental.chat.system.transform"](
                { sessionID: other, model: { limit: { context: 200000 } } },
                { system: ["synthetic"] },
            ).then(() => (systemDone = true))
            const command = hooks["command.execute.before"](
                { command: "dcp", sessionID: other, arguments: "manual off" },
                { parts: [] },
            ).then(() => (commandDone = true))
            await pause(100)
            assert.equal(systemDone, false, "system hook ran during another turn's count")
            assert.equal(commandDone, false, "command ran during another turn's count")
            await rejected
            await system
            await command
        } finally {
            clearInterval(heartbeat)
        }
        assert.ok(gap < 250, `event loop blocked for ${gap} ms`)
        await hooks["experimental.chat.messages.transform"]({}, { messages: messages(other) })
    },
)
