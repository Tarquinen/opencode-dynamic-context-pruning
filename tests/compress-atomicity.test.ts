// A token-count failure must leave compression and session state exactly as before.
import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TokenCountError, tokenCounter } from "../lib/token-counter"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-atomicity-data-"))
process.env.XDG_DATA_HOME = dataHome
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dcp-atomicity-config-"))

// Counts are deterministic and fail for any text containing FAIL. Text containing GATE
// waits for release(), so tests can interleave other operations with an awaited count.
let counted: string[] = []
let gate: Promise<void> | undefined
let entered = () => {}
let release = () => {}
function holdGate(): Promise<void> {
    gate = new Promise<void>((resolve) => (release = resolve))
    return new Promise<void>((resolve) => (entered = resolve))
}
tokenCounter.count = async (text: string) => {
    counted.push(text)
    if (text.includes("GATE") && gate) {
        const held = gate
        gate = undefined
        entered()
        await held
    }
    if (text.includes("FAIL")) throw new TokenCountError("timeout")
    return text.length
}

const { createCompressRangeTool } = await import("../lib/compress/range")
const { createCompressMessageTool } = await import("../lib/compress/message")
const { createSessionState, ensureSessionInitialized, loadSessionState, saveSessionState } =
    await import("../lib/state")
const { Logger } = await import("../lib/logger")
const { PromptStore } = await import("../lib/prompts/store")
const { exclusive } = await import("../lib/state")
const {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createSystemPromptHandler,
} = await import("../lib/hooks")

// The legacy server's shared-state hooks, wired exactly as in index.ts (which tests cannot
// import directly because of its config loader's jsonc-parser ESM import).
function server(mode: "range" | "message", client: any, compress: Record<string, unknown> = {}) {
    const settings = config(mode)
    Object.assign(settings.compress, compress)
    const logger = new Logger(false)
    const state = createSessionState()
    const directory = mkdtempSync(join(tmpdir(), "dcp-server-project-"))
    const prompts = new PromptStore(logger, directory, false)
    const permissions = { global: undefined, agents: {} }
    const transformMessages = createChatMessageTransformHandler(
        client,
        state,
        logger,
        settings,
        prompts,
        permissions,
    )
    const executeCommand = createCommandExecuteHandler(
        client,
        state,
        logger,
        settings,
        directory,
        permissions,
    )
    const transformSystem = createSystemPromptHandler(state, logger, settings, prompts)
    const ctx = { client, state, logger, config: settings, prompts }
    return {
        "experimental.chat.system.transform": (input: any, output: any) =>
            exclusive(state, () => transformSystem(input, output)),
        "experimental.chat.messages.transform": (input: any, output: any) =>
            exclusive(state, () => transformMessages(input, output)),
        "command.execute.before": (input: any, output: any) =>
            exclusive(state, () => executeCommand(input, output)),
        tool: {
            compress:
                mode === "message" ? createCompressMessageTool(ctx) : createCompressRangeTool(ctx),
        },
    } as any
}

function config(mode: "range" | "message") {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: true, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode,
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    } as any
}

function messages(sessionID: string) {
    return [1, 2, 3].map((n) => ({
        info: {
            id: `msg-${n}`,
            role: n === 2 ? "assistant" : "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: n },
        },
        parts: [
            {
                id: `part-${n}`,
                messageID: `msg-${n}`,
                sessionID,
                type: "text",
                text: `message ${n} text`,
            },
        ],
    })) as any[]
}

function harness(mode: "range" | "message", sessionID = `ses_atomic_${mode}_${Date.now()}`) {
    const state = createSessionState()
    const sideEffects: string[] = []
    const ctx = {
        client: {
            session: {
                messages: async () => ({ data: messages(sessionID) }),
                get: async () => ({ data: { parentID: null } }),
                prompt: async () => sideEffects.push("prompt"),
            },
            tui: { showToast: async () => sideEffects.push("toast") },
        },
        state,
        logger: new Logger(false),
        config: config(mode),
        prompts: {
            reload() {},
            getRuntimePrompts: () => ({ compressRange: "", compressMessage: "" }),
        },
    } as any
    const toolContext = {
        ask: async () => {},
        metadata: () => {},
        sessionID,
        messageID: "msg-compress",
    }
    return { state, ctx, toolContext, sideEffects }
}

function snapshot(state: any) {
    const messages = state.prune.messages
    return JSON.stringify({
        blocks: [...messages.blocksById.entries()],
        byMessage: [...messages.byMessageId.entries()],
        nextBlockId: messages.nextBlockId,
        nextRunId: messages.nextRunId,
        stats: state.stats,
    })
}

for (const mode of ["range", "message"] as const) {
    test(`${mode} compression applies nothing when a later summary cannot be counted`, async () => {
        const { state, ctx, toolContext, sideEffects } = harness(mode)
        const tool =
            mode === "range" ? createCompressRangeTool(ctx) : createCompressMessageTool(ctx)
        const content =
            mode === "range"
                ? [
                      { startId: "m0001", endId: "m0001", summary: "first summary" },
                      { startId: "m0002", endId: "m0002", summary: "second FAIL summary" },
                  ]
                : [
                      { messageId: "m0001", topic: "one", summary: "first summary" },
                      { messageId: "m0002", topic: "two", summary: "second FAIL summary" },
                  ]
        counted = []
        // Initialise the session first so the snapshot reflects pre-compression state.
        await assert.rejects(tool.execute({ topic: "boom", content } as any, toolContext))
        const before = snapshot(state)
        assert.ok(counted.some((text) => text.includes("first summary")))
        await assert.rejects(tool.execute({ topic: "boom", content } as any, toolContext), {
            name: "TokenCountError",
        })
        assert.equal(snapshot(state), before)
        assert.equal(state.prune.messages.blocksById.size, 0)
        assert.deepEqual(sideEffects, [])

        // The same tool succeeds once counting works, proving no allocation leaked.
        const ok = content.map((entry) => ({
            ...entry,
            summary: entry.summary.replace("FAIL ", ""),
        }))
        await tool.execute({ topic: "fine", content: ok } as any, toolContext)
        assert.deepEqual([...state.prune.messages.blocksById.keys()], [1, 2])
    })
}

test("session initialisation failure leaves the session uninitialised", async () => {
    const sessionID = `ses_atomic_init_${Date.now()}`
    // Persist through the module so the storage directory matches its (shared) configuration.
    const persisted = createSessionState()
    persisted.sessionId = sessionID
    persisted.prune.messages.nextBlockId = 2
    persisted.prune.messages.nextRunId = 2
    // A stored block without summaryTokens is recounted on restore.
    persisted.prune.messages.blocksById.set(1, {
        blockId: 1,
        summary: "persisted FAIL summary",
        active: true,
    } as any)
    persisted.stats = { pruneTokenCounter: 7, totalPruneTokens: 9 }
    await saveSessionState(persisted, new Logger(false))
    const state = createSessionState()
    const client = { session: { get: async () => ({ data: { parentID: null } }) } }
    await assert.rejects(
        ensureSessionInitialized(
            client,
            state,
            sessionID,
            new Logger(false),
            messages(sessionID),
            false,
        ),
        { name: "TokenCountError" },
    )
    assert.equal(state.sessionId, null)
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.stats.totalPruneTokens, 0)
})

function compressContent(mode: "range" | "message", summary: string) {
    return mode === "range"
        ? [{ startId: "m0001", endId: "m0001", summary }]
        : [{ messageId: "m0001", topic: "one", summary }]
}

for (const mode of ["range", "message"] as const) {
    test(`legacy server serialises ${mode} compression against another session's turn`, async () => {
        const a = `ses_owner_${mode}_A_${Date.now()}`
        const b = `ses_owner_${mode}_B_${Date.now()}`
        const client = {
            session: {
                messages: async ({ path }: any) => ({ data: messages(path.id) }),
                get: async () => ({ data: { parentID: null } }),
                prompt: async () => {},
            },
            tui: { showToast: async () => {} },
        }
        const hooks = server(mode, client)
        const held = holdGate()
        const compressA = hooks.tool.compress.execute(
            { topic: "A", content: compressContent(mode, "A GATE summary") },
            { ask: async () => {}, metadata: () => {}, sessionID: a, messageID: "msg-compress" },
        )
        await held
        let turnDone = false
        const turnB = hooks["experimental.chat.messages.transform"](
            {},
            { messages: messages(b) },
        ).then(() => (turnDone = true))
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(turnDone, false, "B's turn must wait while A owns the shared state")
        release()
        await compressA
        await turnB
        const persistedA = await loadSessionState(a, new Logger(false))
        assert.match(JSON.stringify(persistedA?.prune.messages), /A GATE summary/)
        const persistedB = await loadSessionState(b, new Logger(false))
        assert.doesNotMatch(JSON.stringify(persistedB ?? {}), /A GATE summary/)
    })

    test(`${mode} compression never applies to a state replaced during counting`, async () => {
        const { state, ctx, toolContext } = harness(mode, `ses_replaced_${mode}_A_${Date.now()}`)
        const tool =
            mode === "range" ? createCompressRangeTool(ctx) : createCompressMessageTool(ctx)
        const held = holdGate()
        const compressA = tool.execute(
            { topic: "A", content: compressContent(mode, "A GATE summary") } as any,
            toolContext,
        )
        await held
        const b = `ses_replaced_${mode}_B_${Date.now()}`
        await ensureSessionInitialized(ctx.client, state, b, ctx.logger, messages(b), false)
        release()
        await assert.rejects(compressA, /state changed/)
        assert.equal(state.sessionId, b)
        assert.equal(state.prune.messages.blocksById.size, 0)
        assert.equal(await loadSessionState(b, ctx.logger), null)
    })
}

for (const outcome of ["fails", "succeeds"] as const) {
    test(`restoration that ${outcome} late never changes a newer session's state`, async () => {
        const logger = new Logger(false)
        const persisted = createSessionState()
        persisted.sessionId = `ses_restore_${outcome}_A_${Date.now()}`
        persisted.prune.messages.blocksById.set(1, {
            blockId: 1,
            summary: outcome === "fails" ? "GATE FAIL recount" : "GATE recount",
            active: true,
        } as any)
        await saveSessionState(persisted, logger)
        const state = createSessionState()
        const client = { session: { get: async () => ({ data: { parentID: null } }) } }
        const held = holdGate()
        const restoreA = ensureSessionInitialized(
            client,
            state,
            persisted.sessionId,
            logger,
            [],
            false,
        )
        await held
        const b = `ses_restore_${outcome}_B_${Date.now()}`
        await ensureSessionInitialized(client, state, b, logger, [], false)
        state.stats.totalPruneTokens = 123
        release()
        await assert.rejects(
            restoreA,
            outcome === "fails" ? { name: "TokenCountError" } : /state changed/,
        )
        assert.equal(state.sessionId, b)
        assert.equal(state.stats.totalPruneTokens, 123)
        assert.equal(state.prune.messages.blocksById.size, 0)
    })
}

// Two-message session with token usage, so threshold nudges depend on the model context.
function usageMessages(sessionID: string, high = false) {
    return [1, 2].map((n) => ({
        info: {
            id: `msg-${n}`,
            role: n === 1 ? "user" : "assistant",
            sessionID,
            agent: "assistant",
            model: { providerID: "synthetic", modelID: "fixture" },
            tokens: {
                input: high ? 89999 : 99,
                output: 1,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
            time: { created: n },
        },
        parts: [
            {
                id: `part-${n}`,
                messageID: `msg-${n}`,
                sessionID,
                type: "text",
                text: high && n === 1 ? "GATE" : `message ${n}`,
            },
        ],
    })) as any[]
}

async function legacyServer(mode: "range" | "message") {
    const client = {
        session: {
            messages: async ({ path }: any) => ({ data: usageMessages(path.id) }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async () => {},
        },
        tui: { showToast: async () => {} },
    }
    return server(mode, client, {
        maxContextLimit: "80%",
        minContextLimit: 200000,
        protectUserMessages: false,
        protectTags: false,
    })
}

test("another session's system hook cannot change a counting turn's model context", async () => {
    async function turn(interleave: boolean) {
        const hooks = await legacyServer("range")
        const a = `ses_system_A_${interleave}_${Date.now()}`
        await hooks["experimental.chat.messages.transform"]({}, { messages: usageMessages(a) })
        await hooks["experimental.chat.system.transform"](
            { sessionID: a, model: { limit: { context: 100000 } } },
            { system: ["synthetic system"] },
        )
        const output = { messages: usageMessages(a, true) }
        const held = holdGate()
        const counting = hooks["experimental.chat.messages.transform"]({}, output)
        await held
        const other = interleave
            ? hooks["experimental.chat.system.transform"](
                  {
                      sessionID: `ses_system_B_${Date.now()}`,
                      model: { limit: { context: 200000 } },
                  },
                  { system: ["other system"] },
              )
            : undefined
        release()
        await counting
        await other
        return output.messages.flatMap((m) => m.parts.map((p: any) => p.text))
    }
    const alone = await turn(false)
    assert.ok(
        JSON.stringify(alone).length > 1000,
        "A's 90% usage of 100k must produce its firm nudge",
    )
    assert.deepEqual(await turn(true), alone)
})

for (const mode of ["range", "message"] as const) {
    for (const trigger of [false, true]) {
        const name = trigger
            ? `${mode} compression triggered by /dcp-compress still runs after approval`
            : `${mode} compression is blocked when manual mode starts during approval`
        test(name, async () => {
            const hooks = await legacyServer(mode)
            const sessionID = `ses_approval_${mode}_${trigger}_${Date.now()}`
            await hooks["experimental.chat.messages.transform"](
                {},
                { messages: usageMessages(sessionID) },
            )
            const command = (args: string) =>
                hooks["command.execute.before"](
                    { command: "dcp", sessionID, arguments: args },
                    { parts: [] },
                )
            if (trigger) {
                await command("manual on")
                await command("compress")
            }
            let approve = () => {}
            let asked = () => {}
            const approval = new Promise<void>((resolve) => (approve = resolve))
            const asking = new Promise<void>((resolve) => (asked = resolve))
            const compression = hooks.tool.compress.execute(
                { topic: "one", content: compressContent(mode, "approved summary") },
                {
                    sessionID,
                    messageID: "msg-compress",
                    metadata() {},
                    ask: async () => {
                        asked()
                        await approval
                    },
                },
            )
            await asking
            if (!trigger) await command("manual on")
            approve()
            const blocks = async () =>
                Object.keys(
                    (await loadSessionState(sessionID, new Logger(false)))?.prune.messages
                        ?.blocksById ?? {},
                ).length
            if (trigger) {
                await compression
                assert.equal(await blocks(), 1)
            } else {
                await assert.rejects(compression, /Manual mode: compress blocked/)
                assert.equal(await blocks(), 0)
            }
        })
    }
}
