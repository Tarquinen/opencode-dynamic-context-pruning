/**
 * DCP Sweep command handler.
 * Prunes tool outputs since the last user message, or the last N tools.
 *
 * Usage:
 *   /dcp sweep        - Prune all tools since the previous user message
 *   /dcp sweep 10     - Prune the last 10 tools
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts, ToolParameterEntry } from "../state"
import type { PluginConfig } from "../config"
import { sendIgnoredMessage } from "../ui/notification"
import { formatPrunedItemsList } from "../ui/utils"
import { getCurrentParams, getTotalToolTokens } from "../token-utils"
import { isIgnoredUserMessage } from "../messages/query"
import { buildToolIdList } from "../messages/utils"
import { saveSessionState } from "../state/persistence"
import { isMessageCompacted } from "../state/utils"
import { isToolProtected } from "../protected-patterns"
import { syncToolCache } from "../state/tool-cache"

export interface SweepCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
    workingDirectory: string
}

function findLastUserMessageIndex(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return i
        }
    }

    return -1
}

function collectToolIdsAfterIndex(
    state: SessionState,
    messages: WithParts[],
    afterIndex: number,
): string[] {
    const toolIds: string[] = []

    for (let i = afterIndex + 1; i < messages.length; i++) {
        const msg = messages[i]
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        if (parts.length > 0) {
            for (const part of parts) {
                if (part.type === "tool" && part.callID && part.tool) {
                    toolIds.push(part.callID)
                }
            }
        }
    }

    return toolIds
}

function formatNoUserMessage(): string {
    const lines: string[] = []

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                      DCP Sweep                            │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Nothing swept: no user message found.")

    return lines.join("\n")
}

function formatSweepMessage(
    toolCount: number,
    tokensSaved: number,
    mode: "since-user" | "last-n",
    toolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
    skippedProtected?: number,
): string {
    const lines: string[] = []

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                      DCP Sweep                            │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")

    if (toolCount === 0) {
        if (mode === "since-user") {
            lines.push("No tools found since the previous user message.")
        } else {
            lines.push(`No tools found to sweep.`)
        }
        if (skippedProtected && skippedProtected > 0) {
            lines.push(`(${skippedProtected} protected tool(s) skipped)`)
        }
    } else {
        if (mode === "since-user") {
            lines.push(`Swept ${toolCount} tool(s) since the previous user message.`)
        } else {
            lines.push(`Swept the last ${toolCount} tool(s).`)
        }
        lines.push(`Tokens saved: ~${tokensSaved.toLocaleString()}`)
        if (skippedProtected && skippedProtected > 0) {
            lines.push(`(${skippedProtected} protected tool(s) skipped)`)
        }
        lines.push("")
        const itemLines = formatPrunedItemsList(toolIds, toolMetadata, workingDirectory)
        lines.push(...itemLines)
    }

    return lines.join("\n")
}

export async function handleSweepCommand(ctx: SweepCommandContext): Promise<void> {
    const { client, state, config, logger, sessionId, messages, args, workingDirectory } = ctx

    const params = getCurrentParams(state, messages, logger)
    const protectedTools = config.commands.protectedTools

    await syncToolCache(state, config, logger, messages)
    buildToolIdList(state, messages)

    // Parse optional numeric argument
    const numArg = args[0] ? parseInt(args[0], 10) : null
    const isLastNMode = numArg !== null && !isNaN(numArg) && numArg > 0

    let toolIdsToSweep: string[]
    let mode: "since-user" | "last-n"

    if (isLastNMode) {
        // Mode: Sweep last N tools
        mode = "last-n"
        const startIndex = Math.max(0, state.toolIdList.length - numArg!)
        toolIdsToSweep = state.toolIdList.slice(startIndex)
        logger.info(`Sweep command: last ${numArg} mode, found ${toolIdsToSweep.length} tools`)
    } else {
        // Mode: Sweep since last user message
        mode = "since-user"
        const lastUserMsgIndex = findLastUserMessageIndex(messages)

        if (lastUserMsgIndex === -1) {
            // No user message found - show message and return
            const message = formatNoUserMessage()
            await sendIgnoredMessage(client, sessionId, message, params, logger)
            logger.info("Sweep command: no user message found")
            return
        } else {
            toolIdsToSweep = collectToolIdsAfterIndex(state, messages, lastUserMsgIndex)
            logger.info(
                `Sweep command: found last user at index ${lastUserMsgIndex}, sweeping ${toolIdsToSweep.length} tools`,
            )
        }
    }

    // Filter out already-pruned tools, protected tools, and protected file paths
    const newToolIds = toolIdsToSweep.filter((id) => {
        if (state.prune.tools.has(id)) {
            return false
        }
        const entry = state.toolParameters.get(id)
        if (!entry) {
            return true
        }
        if (
            isToolProtected(
                entry.tool,
                entry.parameters,
                protectedTools,
                config.protectedFilePatterns,
                entry.metadata,
            )
        ) {
            logger.debug(`Sweep: skipping protected tool ${entry.tool} (${id})`)
            return false
        }
        return true
    })

    // Count how many were skipped due to protection
    const skippedProtected = toolIdsToSweep.filter((id) => {
        const entry = state.toolParameters.get(id)
        if (!entry) {
            return false
        }
        return isToolProtected(
            entry.tool,
            entry.parameters,
            protectedTools,
            config.protectedFilePatterns,
            entry.metadata,
        )
    }).length

    if (newToolIds.length === 0) {
        const message = formatSweepMessage(
            0,
            0,
            mode,
            [],
            new Map(),
            workingDirectory,
            skippedProtected,
        )
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        logger.info("Sweep command: no new tools to sweep", { skippedProtected })
        return
    }

    const tokensSaved = getTotalToolTokens(state, newToolIds)

    // Add to prune list
    for (const id of newToolIds) {
        const entry = state.toolParameters.get(id)
        state.prune.tools.set(id, entry?.tokenCount ?? 0)
    }
    state.stats.pruneTokenCounter += tokensSaved
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0

    // Collect metadata for logging
    const toolMetadata: Map<string, ToolParameterEntry> = new Map()
    for (const id of newToolIds) {
        const entry = state.toolParameters.get(id)
        if (entry) {
            toolMetadata.set(id, entry)
        }
    }

    // Persist state
    saveSessionState(state, logger).catch((err) =>
        logger.error("Failed to persist state after sweep", { error: err.message }),
    )

    const message = formatSweepMessage(
        newToolIds.length,
        tokensSaved,
        mode,
        newToolIds,
        toolMetadata,
        workingDirectory,
        skippedProtected,
    )
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Sweep command completed", {
        toolsSwept: newToolIds.length,
        tokensSaved,
        skippedProtected,
        mode,
        tools: Array.from(toolMetadata.entries()).map(([id, entry]) => ({
            id,
            tool: entry.tool,
        })),
    })
}
