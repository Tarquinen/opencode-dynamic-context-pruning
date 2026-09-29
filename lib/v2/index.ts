import type { Plugin } from "@opencode/plugin"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { compressToolName, getConfig } from "../config"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { createCompressMessageTool, createCompressRangeTool } from "../compress"
import { attachCompressionDuration } from "../compress/state"
import { createCommandExecuteHandler, createSystemPromptHandler } from "../hooks"
import {
    createSessionState,
    ensureSessionInitialized,
    checkSession,
    saveSessionState,
    syncToolCache,
    type SessionState,
} from "../state"
import { assignMessageRefs } from "../message-ids"
import { applyPendingManualTrigger } from "../commands/manual"
import { deduplicate, purgeErrors } from "../strategies"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectMessageIds,
    injectExtendedSubAgentResults,
    prune,
    stripHallucinations,
    syncCompressionBlocks,
} from "../messages"
import { countTokens, getCurrentTokenUsage } from "../token-utils"
import { matchesGlob } from "../protected-patterns"
import { history, project } from "./messages"
import { analyzeContextTokens } from "../commands/context"
import { buildStatsReport } from "../commands/stats"
import { rpc } from "./rpc"

// V2 reports become ephemeral rpc events that the TUI plugin renders as
// toasts. Never use synthetic() here: its text would enter the model's
// context, unlike V1 ignored messages. Without a registered emitter (host
// without rpc events, or plugin disabled) reports degrade to the log.
let emitNotify:
    | ((event: {
          title: string
          message: string
          variant?: "info" | "success" | "warning" | "error"
          duration?: number
      }) => Promise<void>)
    | undefined

const REPORT_TOAST_MAX_CHARS = 2000

export async function report(logger: Logger, text: string, sessionID?: string) {
    logger.debug("V2 report", { sessionID, text })
    if (!emitNotify || !text) return
    const message =
        text.length > REPORT_TOAST_MAX_CHARS
            ? `${text.slice(0, REPORT_TOAST_MAX_CHARS)}\n... (truncated, ${text.length} chars total)`
            : text
    try {
        await emitNotify({ title: "DCP", message })
    } catch (cause) {
        logger.debug("V2 report emit failed", { error: String(cause) })
    }
}

/** The host's `event.tools` expects a JSON Schema, not a zod schema. */
function compressToolInputSchema(definition: ToolDefinition): Record<string, unknown> {
    try {
        return tool.schema.toJSONSchema(tool.schema.object(definition.args)) as Record<
            string,
            unknown
        >
    } catch {
        return { type: "object", properties: {} }
    }
}

export async function setup(ctx: Plugin.Context) {
    const warnings = {
        tui: {
            showToast: async (input: { body: { message: string } }) => {
                console.warn(`DCP: ${input.body.message}`)
            },
        },
    }
    const config = getConfig({ directory: ctx.location.directory, client: warnings })
    if (!config.enabled) {
        await ctx.rpc.register(
            { ...rpc, methods: { status: rpc.methods.status } },
            { status: async () => ({ enabled: false }) },
        )
        return
    }
    const logger = new Logger(config.debug)
    const prompts = new PromptStore(
        logger,
        ctx.location.directory,
        config.experimental.customPrompts,
        "compact",
    )
    const sessions = new Map<string, SessionState>()
    const queues = new Map<string, Promise<unknown>>()
    const limits = new Map<string, number>()
    const aliases: Record<string, string> = {
        task: "subagent",
        bash: "shell",
        apply_patch: "patch",
    }
    for (const list of [
        config.compress.protectedTools,
        config.commands.protectedTools,
        config.strategies.deduplication.protectedTools,
        config.strategies.purgeErrors.protectedTools,
    ]) {
        for (const name of [...list])
            if (aliases[name] && !list.includes(aliases[name]!)) list.push(aliases[name]!)
    }

    function serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
        const pending = (queues.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation)
        queues.set(sessionID, pending)
        void pending
            .finally(() => {
                if (queues.get(sessionID) === pending) queues.delete(sessionID)
            })
            .catch(() => {})
        return pending
    }

    const client = {
        session: {
            get: async ({ path }: { path: { id: string } }) => ({
                data: await ctx.session.get({ sessionID: path.id }),
            }),
            messages: async ({ path }: { path: { id: string } }) => {
                const [entries, session] = await Promise.all([
                    ctx.session.context({ sessionID: path.id }),
                    ctx.session.get({ sessionID: path.id }),
                ])
                return { data: history(entries, session) }
            },
            prompt: async (input: {
                path: { id: string }
                body: { parts: Array<{ text: string }> }
            }) =>
                report(logger, input.body.parts.map((part) => part.text).join("\n"), input.path.id),
        },
        tui: {
            showToast: async (input: { body: { message: string } }) =>
                report(logger, input.body.message),
        },
    }

    async function load(sessionID: string, agentID?: string) {
        const [session, entries] = await Promise.all([
            ctx.session.get({ sessionID }),
            ctx.session.context({ sessionID }),
        ])
        const selected =
            agentID ??
            session.agent ??
            entries.findLast((entry) => entry.type === "assistant")?.agent
        if (!selected) throw new Error("DCP commands require a session with a selected agent")
        const { data: agent } = await ctx.agent.get({ agentID: selected })
        let state = sessions.get(sessionID)
        if (!state) {
            state = createSessionState("compact")
            sessions.set(sessionID, state)
        }
        const messages = history(entries, session)
        await ensureSessionInitialized(
            client,
            state,
            sessionID,
            logger,
            messages,
            config.manualMode.enabled,
        )
        await checkSession(client, state, logger, messages, config.manualMode.enabled)
        // Only rules that name the "compress" action explicitly decide DCP's
        // verdict. V2 hosts ship agents with catch-all deny/ask policies and
        // treat unmatched actions as "ask"; honoring those wildcards here
        // silently disabled compression everywhere (the tool got deleted from
        // the request or `allowed()` threw). This mirrors v1, which injected
        // an explicit allow unless the user configured the tool directly.
        // Wildcard policies still apply to the host's own enforcement; the
        // permission evaluate hook below aligns the two.
        const rules = [...agent.permissions, ...(session.permissions ?? [])]
        const explicitRule = rules.findLast(
            (rule) =>
                rule.action !== "*" &&
                matchesGlob("compress", rule.action) &&
                matchesGlob("*", rule.resource),
        )
        state.compressPermission =
            config.compress.permission === "deny"
                ? "deny"
                : explicitRule?.effect === "deny"
                  ? "deny"
                  : config.compress.permission === "ask" || explicitRule?.effect === "ask"
                    ? "ask"
                    : "allow"
        logger.info("DCP compress permission resolved", {
            sessionID,
            agent: selected,
            permission: state.compressPermission,
            source: explicitRule
                ? `explicit rule ${explicitRule.action} -> ${explicitRule.effect}`
                : "config default (wildcard host rules ignored)",
        })
        return { state, entries, session, messages }
    }

    function allowed(state: SessionState) {
        if (state.isSubAgent && !config.experimental.allowSubAgents)
            throw new Error("DCP compression is disabled in subagents")
        if (state.compressPermission === "deny") throw new Error("DCP compression is denied")
        if (state.compressPermission === "ask")
            throw new Error(
                "DCP: compress permission 'ask' is not supported by OpenCode V2's public plugin API yet. Compression was not performed.",
            )
    }

    // Lazy description/schema source for self-healing tool exposure; the
    // per-session execution path (tool.transform below) keeps building its own
    // session-bound definition.
    let compressDefinition: ToolDefinition | undefined
    const compressDefinitionFor = () =>
        config.compress.permission === "deny"
            ? undefined
            : (compressDefinition ??= (config.compress.mode === "message"
                  ? createCompressMessageTool
                  : createCompressRangeTool)({
                  client,
                  state: createSessionState(),
                  logger,
                  config,
                  prompts,
              }))

    // Align host enforcement with DCP's verdict. V2 hosts treat unmatched tool
    // actions as "ask" and several built-in agents ship catch-all deny
    // policies, so dcp_compress calls stall or fail even when DCP itself
    // allows compression. Only the "compress" action is overridden, and only
    // while DCP's own config is "allow" (explicit "deny"/"ask" configs keep
    // host behavior untouched).
    if (config.compress.permission === "allow") {
        await ctx.permission.hook("evaluate", (evaluation) => {
            if (evaluation.action !== "compress") return
            evaluation.effect = "allow"
        })
    }

    await ctx.model.transform((editor) => {
        limits.clear()
        for (const model of editor.list())
            limits.set(`${model.providerID}/${model.id}`, model.limit.context)
    })
    for (const kind of ["context", "compaction"] as const)
        await ctx.session.hook(kind, (event) =>
            serial(event.sessionID, async () => {
                const { state, entries, session, messages } = await load(
                    event.sessionID,
                    event.agent,
                )
                if (state.isSubAgent && !config.experimental.allowSubAgents) {
                    delete event.tools[compressToolName(config)]
                    return
                }
                if (state.compressPermission === "deny") {
                    delete event.tools[compressToolName(config)]
                } else if (event.tools[compressToolName(config)] === undefined) {
                    // Self-heal tool exposure: if the host dropped or never
                    // listed the plugin tool, the injected nudges reference a
                    // phantom tool and the model can never compress (total,
                    // silent failure). Re-add it from DCP's own definition.
                    const definition = compressDefinitionFor()
                    if (definition) {
                        event.tools[compressToolName(config)] = {
                            description: definition.description,
                            input: compressToolInputSchema(definition),
                        }
                    }
                }
                state.modelContextLimit = limits.get(`${event.model.providerID}/${event.model.id}`)
                state.systemPromptTokens = countTokens(
                    event.system.map((part) => part.text).join("\n"),
                )
                const view = project(event.messages, entries, {
                    ...session,
                    agent: event.agent,
                    model: event.model,
                })
                stripHallucinations(view.messages, state.idFormat)
                assignMessageRefs(state, view.messages)
                // Compaction may select only a prefix; block origins can be in the retained tail.
                const blocksChanged = syncCompressionBlocks(state, logger, messages)
                syncToolCache(state, config, logger, view.messages)
                buildToolIdList(state, view.messages)
                // Mirror the compress-tool pipeline: the automatic strategies mark
                // superseded/failed tool outputs for pruning on every request, not
                // only while a compress tool call is being prepared. Without this,
                // state.prune.tools stays empty forever on the V2 path.
                const pruneToolsBefore = state.prune.tools.size
                deduplicate(state, logger, config, view.messages)
                purgeErrors(state, logger, config, view.messages)
                const pruneToolsChanged = state.prune.tools.size > pruneToolsBefore
                prune(state, logger, config, view.messages, view.summaryBase)
                // Write through block-liveness and prune-marking changes so a
                // server restart cannot lose them to a later stale save.
                if (blocksChanged || pruneToolsChanged) {
                    await saveSessionState(state, logger)
                }
                await injectExtendedSubAgentResults(
                    client,
                    state,
                    logger,
                    view.messages,
                    config.experimental.allowSubAgents,
                )
                const priorities = buildPriorityMap(config, state, view.messages)
                prompts.reload()
                injectCompressNudges(
                    state,
                    config,
                    logger,
                    view.messages,
                    prompts.getRuntimePrompts(),
                    priorities,
                    kind === "context",
                )
                injectMessageIds(state, config, view.messages, priorities)
                applyPendingManualTrigger(state, view.messages, logger)
                event.messages = view.restore()
                const system = { system: event.system.map((part) => part.text) }
                await createSystemPromptHandler(
                    state,
                    logger,
                    config,
                    prompts,
                )(
                    {
                        sessionID: event.sessionID,
                        model: { limit: { context: state.modelContextLimit ?? 0 } },
                    },
                    system,
                )
                event.system = system.system.map((text, index) => ({
                    ...event.system[index],
                    type: "text",
                    text,
                }))
                await logger.saveContext(event.sessionID, view.messages)
                logger.debug("V2 hook applied", {
                    sessionID: event.sessionID,
                    kind,
                    tokenUsage: getCurrentTokenUsage(state, view.messages),
                    blocks: state.prune.messages.blocksById.size,
                    pruneTools: state.prune.tools.size,
                    compressPermission: state.compressPermission,
                    toolExposed: event.tools[compressToolName(config)] !== undefined,
                    manualMode: state.manualMode,
                })
            }),
        )

    if (config.compress.permission !== "deny") {
        const define = (state: SessionState): ToolDefinition =>
            (config.compress.mode === "message"
                ? createCompressMessageTool
                : createCompressRangeTool)({ client, state, logger, config, prompts })
        const definition = define(createSessionState("compact"))
        await ctx.tool.transform((editor) =>
            editor.add({
                name: compressToolName(config),
                description: definition.description,
                input: tool.schema.object(definition.args),
                options: { codemode: false, permission: "compress" },
                execute: (input, context) =>
                    serial(context.sessionID, async () => {
                        const { state } = await load(context.sessionID, context.agent)
                        allowed(state)
                        const started = Date.now()
                        const legacy = define(state)
                        const content = await legacy.execute(input, {
                            sessionID: context.sessionID,
                            messageID: context.messageID,
                            callID: context.id,
                            agent: context.agent,
                            directory: ctx.location.directory,
                            worktree: ctx.location.directory,
                            abort: new AbortController().signal,
                            ask: async () => allowed(state),
                            metadata: ({ title }: { title?: string }) => {
                                void context.progress({ title })
                            },
                        } as Parameters<typeof legacy.execute>[1])
                        attachCompressionDuration(
                            state.prune.messages,
                            context.messageID,
                            context.id,
                            Date.now() - started,
                        )
                        await saveSessionState(state, logger)
                        // Both shared compression executors return text; the V1 helper's
                        // public return type also permits unrelated attachment results.
                        return { content: content as string }
                    }),
            }),
        )
    }
    if (config.commands.enabled)
        await ctx.command.transform((editor) => {
            for (const name of ["dcp", "dcp-compress"])
                editor.add({
                    name,
                    description: name === "dcp" ? "DCP commands" : "Trigger DCP manual compression",
                    execute: async (invocation) => {
                        const prompt = await serial(invocation.sessionID, async () => {
                            const { state } = await load(invocation.sessionID)
                            const permission =
                                state.compressPermission ?? config.compress.permission
                            if (
                                name === "dcp-compress" ||
                                invocation.prompt.text.trim().split(/\s+/)[0] === "compress"
                            )
                                allowed(state)
                            const output = { parts: [] }
                            await createCommandExecuteHandler(
                                client,
                                state,
                                logger,
                                config,
                                ctx.location.directory,
                                { global: { compress: permission }, agents: {} },
                            )(
                                {
                                    command: name,
                                    sessionID: invocation.sessionID,
                                    arguments: invocation.prompt.text,
                                },
                                output,
                            )
                            state.compressPermission = permission
                            const pending = state.pendingManualTrigger
                            if (!pending) return
                            allowed(state)
                            state.pendingManualTrigger = null
                            return pending.prompt
                        })
                        if (prompt)
                            await ctx.session.prompt({
                                sessionID: invocation.sessionID,
                                text: prompt,
                                delivery: invocation.delivery,
                            })
                    },
                })
        })
    await ctx.rpc.register(rpc, {
        status: async () => ({ enabled: config.commands.enabled }),
        snapshot: ({ sessionID }) =>
            serial(sessionID, async () => {
                const { state, messages } = await load(sessionID)
                syncCompressionBlocks(state, logger, messages)
                return {
                    manualMode: !!state.manualMode,
                    canCompress:
                        state.compressPermission === "allow" &&
                        (!state.isSubAgent || config.experimental.allowSubAgents),
                    ...(state.compressPermission === "ask"
                        ? {
                              blockedReason:
                                  "Permission 'ask' is not supported by the V2 plugin API yet.",
                          }
                        : {}),
                    context: analyzeContextTokens(state, messages),
                    stats: await buildStatsReport(state, logger),
                }
            }),
        manual: ({ sessionID, enabled }) =>
            serial(sessionID, async () => {
                const { state } = await load(sessionID)
                state.manualMode = enabled ? "active" : false
                await saveSessionState(state, logger)
                return {}
            }),
    }).then((registration) => {
        emitNotify = (event) => registration.events.emit("notify", event)
    })
    logger.info("DCP V2 initialized")
    return () => {
        sessions.clear()
        limits.clear()
    }
}
