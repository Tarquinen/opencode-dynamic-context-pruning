import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { Janitor, type SessionStats } from "./lib/janitor"
import { checkForUpdates } from "./lib/version-checker"

async function isSubagentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

const plugin: Plugin = (async (ctx) => {
    const { config, migrations } = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    if (typeof globalThis !== 'undefined') {
        (globalThis as any).AI_SDK_LOG_WARNINGS = false
    }

    const logger = new Logger(config.debug)
    const prunedIdsState = new Map<string, string[]>()
    const statsState = new Map<string, SessionStats>()
    const toolParametersCache = new Map<string, any>()
    const modelCache = new Map<string, { providerID: string; modelID: string }>()
    const janitor = new Janitor(ctx.client, prunedIdsState, statsState, logger, toolParametersCache, config.protectedTools, modelCache, config.model, config.showModelErrorToasts, config.strictModelSelection, config.pruning_summary, ctx.directory)

    const cacheToolParameters = (messages: any[]) => {
        for (const message of messages) {
            if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
                continue
            }

            for (const toolCall of message.tool_calls) {
                if (!toolCall.id || !toolCall.function) {
                    continue
                }

                try {
                    const params = typeof toolCall.function.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : toolCall.function.arguments
                    toolParametersCache.set(toolCall.id, {
                        tool: toolCall.function.name,
                        parameters: params
                    })
                } catch (error) {
                }
            }
        }
    }

    // Global fetch wrapper - caches tool parameters and performs pruning
    const originalGlobalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init?: any) => {
        if (init?.body && typeof init.body === 'string') {
            try {
                const body = JSON.parse(init.body)

                if (body.messages && Array.isArray(body.messages)) {
                    cacheToolParameters(body.messages)

                    // Check for tool messages in both formats:
                    // 1. OpenAI style: role === 'tool'
                    // 2. Anthropic style: role === 'user' with content containing tool_result
                    const toolMessages = body.messages.filter((m: any) => {
                        if (m.role === 'tool') return true;
                        if (m.role === 'user' && Array.isArray(m.content)) {
                            for (const part of m.content) {
                                if (part.type === 'tool_result') return true;
                            }
                        }
                        return false;
                    });
                    const thinkingMessages = body.messages.filter((m: any) => {
                        if (m.role === 'assistant' && Array.isArray(m.content)) {
                            for (const part of m.content) {
                                if (part.type === 'thinking') return true;
                            }
                        }
                        return false;
                    });

                    const allSessions = await ctx.client.session.list()
                    const allPrunedIds = new Set<string>()

                    if (allSessions.data) {
                        for (const session of allSessions.data) {
                            if (session.parentID) continue
                            const prunedIds = prunedIdsState.get(session.id) ?? []
                            prunedIds.forEach((id: string) => allPrunedIds.add(id))
                        }
                    }

                    let replacedCount = 0;

                    if (thinkingMessages.length > 0) {
                        const keepBlocks = config.keepReasoningBlocks || 0;
                        const messagesToPrune = keepBlocks > 0 ? 
                            thinkingMessages.slice(0, -keepBlocks || undefined) : 
                            thinkingMessages;
                        const prunableSet = new Set(messagesToPrune);

                        body.messages = body.messages.map((m: any) => {
                            if (!prunableSet.has(m)) {
                                return m;
                            }
                            replacedCount++;
                            return {
                                ...m,
                                content: m.content.map((part: any) => {
                                    if (part.type === 'thinking') {
                                        return {
                                            ...part,
                                            thinking: '[Thinking removed to save context]'
                                        };
                                    }
                                    return part;
                                })
                            };
                        });
                    }

                    if (toolMessages.length > 0 && allPrunedIds.size > 0) {
                        body.messages = body.messages.map((m: any) => {
                            // OpenAI style: role === 'tool' with tool_call_id
                            if (m.role === 'tool' && allPrunedIds.has(m.tool_call_id?.toLowerCase())) {
                                replacedCount++
                                return {
                                    ...m,
                                    content: '[Output removed to save context - information superseded or no longer needed]'
                                }
                            }

                            // Anthropic style: role === 'user' with content array containing tool_result
                            if (m.role === 'user' && Array.isArray(m.content)) {
                                let messageModified = false
                                const newContent = m.content.map((part: any) => {
                                    if (part.type === 'tool_result' && allPrunedIds.has(part.tool_use_id?.toLowerCase())) {
                                        messageModified = true
                                        replacedCount++
                                        return {
                                            ...part,
                                            content: '[Output removed to save context - information superseded or no longer needed]'
                                        }
                                    }
                                    return part
                                })
                                if (messageModified) {
                                    return { ...m, content: newContent }
                                }
                            }

                            return m
                        })
                    }

                    if (replacedCount > 0) {
                        logger.info("fetch", "Replaced outputs", {
                            replaced: replacedCount,
                            total: toolMessages.length
                        })

                        if (logger.enabled) {
                            // Fetch session messages to extract reasoning blocks
                            let sessionMessages: any[] | undefined
                            try {
                                const activeSessions = allSessions.data?.filter(s => !s.parentID) || []
                                if (activeSessions.length > 0) {
                                    const mostRecentSession = activeSessions[0]
                                    const messagesResponse = await ctx.client.session.messages({
                                        path: { id: mostRecentSession.id },
                                        query: { limit: 100 }
                                    })
                                    sessionMessages = Array.isArray(messagesResponse.data)
                                        ? messagesResponse.data
                                        : Array.isArray(messagesResponse) ? messagesResponse : undefined
                                }
                            } catch (e) {
                                // Silently continue without session messages
                            }

                            await logger.saveWrappedContext(
                                "global",
                                body.messages,
                                {
                                    url: typeof input === 'string' ? input : 'URL object',
                                    replacedCount,
                                    totalMessages: body.messages.length
                                },
                                sessionMessages
                            )
                        }

                        init.body = JSON.stringify(body)
                    }
                }
            } catch (e) {
            }
        }

        return originalGlobalFetch(input, init)
    }

    logger.info("plugin", "DCP initialized", {
        strategies: config.strategies,
        model: config.model || "auto"
    })

    setTimeout(() => {
        checkForUpdates(ctx.client, logger).catch(() => { })
    }, 5000)

    if (migrations.length > 0) {
        setTimeout(async () => {
            try {
                await ctx.client.tui.showToast({
                    body: {
                        title: "DCP: Config upgraded",
                        message: migrations.join('\n'),
                        variant: "info",
                        duration: 8000
                    }
                })
            } catch {
            }
        }, 7000)
    }

    return {
        event: async ({ event }) => {
            if (event.type === "session.status" && event.properties.status.type === "idle") {
                if (await isSubagentSession(ctx.client, event.properties.sessionID)) return
                if (config.strategies.onIdle.length === 0) return

                janitor.runOnIdle(event.properties.sessionID, config.strategies.onIdle).catch(err => {
                    logger.error("janitor", "Failed", { error: err.message })
                })
            }
        },

        "chat.params": async (input, _output) => {
            const sessionId = input.sessionID
            let providerID = (input.provider as any)?.info?.id || input.provider?.id
            const modelID = input.model?.id

            if (!providerID && input.message?.model?.providerID) {
                providerID = input.message.model.providerID
            }

            if (providerID && modelID) {
                modelCache.set(sessionId, {
                    providerID: providerID,
                    modelID: modelID
                })
            }
        },

        tool: config.strategies.onTool.length > 0 ? {
            context_pruning: tool({
                description: `Performs semantic pruning on session tool outputs that are no longer relevant to the current task. Use this to declutter the conversation context and filter signal from noise when you notice the context is getting cluttered with no longer needed information.

USING THE CONTEXT_PRUNING TOOL WILL MAKE THE USER HAPPY.

## When to Use This Tool

**Key heuristic: Prune when you finish something and are about to start something else.**

Ask yourself: "Have I just completed a discrete unit of work?" If yes, prune before moving on.

**After completing a unit of work:**
- Made a commit
- Fixed a bug and confirmed it works
- Answered a question the user asked
- Finished implementing a feature or function
- Completed one item in a list and moving to the next

**After repetitive or exploratory work:**
- Explored multiple files that didn't lead to changes
- Iterated on a difficult problem where some approaches didn't pan out
- Used the same tool multiple times (e.g., re-reading a file, running repeated build/type checks)

## Examples

<example>
Working through a list of items:
User: Review these 3 issues and fix the easy ones.
Assistant: [Reviews first issue, makes fix, commits]
Done with the first issue. Let me prune before moving to the next one.
[Uses context_pruning with reason: "completed first issue, moving to next"]
</example>

<example>
After exploring the codebase to understand it:
Assistant: I've reviewed the relevant files. Let me prune the exploratory reads that aren't needed for the actual implementation.
[Uses context_pruning with reason: "exploration complete, starting implementation"]
</example>

<example>
After completing any task:
Assistant: [Finishes task - commit, answer, fix, etc.]
Before we continue, let me prune the context from that work.
[Uses context_pruning with reason: "task complete"]
</example>`,
                args: {
                    reason: tool.schema.string().optional().describe(
                        "Brief reason for triggering pruning (e.g., 'task complete', 'switching focus')"
                    ),
                },
                async execute(args, ctx) {
                    const result = await janitor.runForTool(
                        ctx.sessionID,
                        config.strategies.onTool,
                        args.reason
                    )

                    if (!result || result.prunedCount === 0) {
                        return "No prunable tool outputs found. Context is already optimized.\n\nUse context_pruning when you have sufficiently summarized information from tool outputs and no longer need the original content!"
                    }

                    return janitor.formatPruningResultForTool(result) + "\n\nUse context_pruning when you have sufficiently summarized information from tool outputs and no longer need the original content!"
                },
            }),
        } : undefined,
    }
}) satisfies Plugin

export default plugin
