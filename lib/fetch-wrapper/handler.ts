import type { FetchHandlerContext, FetchHandlerResult, FormatDescriptor, PrunedIdData } from "./types"
import { type PluginState, ensureSessionRestored } from "../state"
import type { Logger } from "../logger"
import { buildPrunableToolsList, buildEndInjection } from "./prunable-list"
import { syncToolCache } from "../state/tool-cache"

const PRUNED_CONTENT_MESSAGE = '[Output removed to save context - information superseded or no longer needed]'

function getMostRecentActiveSession(allSessions: any): any | undefined {
    const activeSessions = allSessions.data?.filter((s: any) => !s.parentID) || []
    return activeSessions.length > 0 ? activeSessions[0] : undefined
}

async function fetchSessionMessages(
    client: any,
    sessionId: string
): Promise<any[] | undefined> {
    try {
        const messagesResponse = await client.session.messages({
            path: { id: sessionId },
            query: { limit: 100 }
        })
        return Array.isArray(messagesResponse.data)
            ? messagesResponse.data
            : Array.isArray(messagesResponse) ? messagesResponse : undefined
    } catch (e) {
        return undefined
    }
}

async function getAllPrunedIds(
    client: any,
    state: PluginState,
    logger?: Logger
): Promise<PrunedIdData> {
    const allSessions = await client.session.list()
    const allPrunedIds = new Set<string>()

    const currentSession = getMostRecentActiveSession(allSessions)
    if (currentSession) {
        await ensureSessionRestored(state, currentSession.id, logger)
        const prunedIds = state.prunedIds.get(currentSession.id) ?? []
        prunedIds.forEach((id: string) => allPrunedIds.add(id.toLowerCase()))

        if (logger && prunedIds.length > 0) {
            logger.debug("fetch", "Loaded pruned IDs for replacement", {
                sessionId: currentSession.id,
                prunedCount: prunedIds.length
            })
        }
    }

    return { allSessions, allPrunedIds }
}

export async function handleFormat(
    body: any,
    ctx: FetchHandlerContext,
    inputUrl: string,
    format: FormatDescriptor
): Promise<FetchHandlerResult> {
    const data = format.getDataArray(body)
    if (!data) {
        return { modified: false, body }
    }

    let modified = false

    // Sync tool parameters from OpenCode's session API (single source of truth)
    // Also tracks new tool results for nudge injection
    const sessionId = ctx.state.lastSeenSessionId
    const protectedSet = new Set(ctx.config.protectedTools)
    if (sessionId) {
        await ensureSessionRestored(ctx.state, sessionId, ctx.logger)
        await syncToolCache(ctx.client, sessionId, ctx.state, ctx.toolTracker, protectedSet, ctx.logger)
    }

    if (ctx.config.strategies.onTool.length > 0) {
        if (format.injectSynth(data, ctx.prompts.synthInstruction, ctx.prompts.nudgeInstruction, ctx.prompts.systemReminder)) {
            modified = true
        }

        if (sessionId) {
            const toolIds = Array.from(ctx.state.toolParameters.keys())
            const alreadyPruned = ctx.state.prunedIds.get(sessionId) ?? []
            const alreadyPrunedLower = new Set(alreadyPruned.map(id => id.toLowerCase()))
            const unprunedIds = toolIds.filter(id => !alreadyPrunedLower.has(id.toLowerCase()))

            const { list: prunableList, numericIds } = buildPrunableToolsList(
                sessionId,
                unprunedIds,
                ctx.state.toolParameters,
                ctx.config.protectedTools
            )

            if (prunableList) {
                const includeNudge = ctx.config.nudge_freq > 0 && ctx.toolTracker.toolResultCount > ctx.config.nudge_freq

                const endInjection = buildEndInjection(prunableList, includeNudge)
                if (format.injectPrunableList(data, endInjection)) {
                    ctx.logger.debug("fetch", `Injected prunable tools list (${format.name})`, {
                        ids: numericIds,
                        nudge: includeNudge,
                        toolsSincePrune: ctx.toolTracker.toolResultCount
                    })
                    modified = true
                }
            }
        }
    }

    if (!format.hasToolOutputs(data)) {
        return { modified, body }
    }

    const { allSessions, allPrunedIds } = await getAllPrunedIds(ctx.client, ctx.state, ctx.logger)

    if (allPrunedIds.size === 0) {
        return { modified, body }
    }

    const toolOutputs = format.extractToolOutputs(data, ctx.state)
    let replacedCount = 0
    let prunableCount = 0

    for (const output of toolOutputs) {
        // Skip tools not in cache (protected tools are excluded from cache)
        if (!output.toolName) continue
        prunableCount++

        if (allPrunedIds.has(output.id)) {
            if (format.replaceToolOutput(data, output.id, PRUNED_CONTENT_MESSAGE, ctx.state)) {
                replacedCount++
            }
        }
    }

    if (replacedCount > 0) {
        ctx.logger.info("fetch", `Replaced pruned tool outputs (${format.name})`, {
            replaced: replacedCount,
            total: prunableCount
        })

        if (ctx.logger.enabled) {
            const activeSessions = allSessions.data?.filter((s: any) => !s.parentID) || []
            let sessionMessages: any[] | undefined
            if (activeSessions.length > 0) {
                const mostRecentSession = activeSessions[0]
                sessionMessages = await fetchSessionMessages(ctx.client, mostRecentSession.id)
            }

            await ctx.logger.saveWrappedContext(
                "global",
                data,
                format.getLogMetadata(data, replacedCount, inputUrl),
                sessionMessages
            )
        }

        return { modified: true, body }
    }

    return { modified, body }
}
