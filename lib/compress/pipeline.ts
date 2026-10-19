import type { WithParts } from "../state"
import { ensureSessionInitialized, exclusive, refreshManualMode } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

async function assertCompressionAllowed(ctx: ToolContext, sessionID: string): Promise<void> {
    await refreshManualMode(ctx.state, sessionID, ctx.logger, ctx.config.manualMode.enabled)

    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }
}

/** Checks manual mode and asks permission; runs before the state lock, as approval may wait. */
export async function authoriseCompression(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<void> {
    await exclusive(ctx.state, () => assertCompressionAllowed(ctx, toolCtx.sessionID))

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })
}

/** Call within exclusive(ctx.state, ...) so no other operation can switch the shared state. */
export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
): Promise<PreparedSession> {
    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )
    // Manual mode may have been switched on while permission was pending.
    await assertCompressionAllowed(ctx, toolCtx.sessionID)

    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    if (ctx.state.manualMode === "compress-pending") {
        ctx.state.manualMode = false
        await refreshManualMode(
            ctx.state,
            toolCtx.sessionID,
            ctx.logger,
            ctx.config.manualMode.enabled,
        )
    }
    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )
}
