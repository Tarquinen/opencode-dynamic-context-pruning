import type { Logger } from "../logger"
import type { SessionStats, PruningResult } from "../core/janitor"
import { formatTokenCount } from "../tokenizer"
import { extractParameterKey } from "./display-utils"

export type PruningSummaryLevel = "off" | "minimal" | "detailed"

export interface NotificationConfig {
    pruningSummary: PruningSummaryLevel
    workingDirectory?: string
}

export interface NotificationContext {
    client: any
    logger: Logger
    config: NotificationConfig
}

// ============================================================================
// Core notification sending
// ============================================================================

export async function sendIgnoredMessage(
    ctx: NotificationContext,
    sessionID: string,
    text: string,
    agent?: string
): Promise<void> {
    try {
        await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
                noReply: true,
                agent: agent,
                parts: [{
                    type: 'text',
                    text: text,
                    ignored: true
                }]
            }
        })
    } catch (error: any) {
        ctx.logger.error("notification", "Failed to send notification", { error: error.message })
    }
}

// ============================================================================
// Pruning notifications
// ============================================================================

export async function sendPruningSummary(
    ctx: NotificationContext,
    sessionID: string,
    llmPrunedIds: string[],
    toolMetadata: Map<string, { tool: string, parameters?: any }>,
    tokensSaved: number,
    sessionStats: SessionStats,
    agent?: string
): Promise<void> {
    const totalPruned = llmPrunedIds.length
    if (totalPruned === 0) return
    if (ctx.config.pruningSummary === 'off') return

    if (ctx.config.pruningSummary === 'minimal') {
        await sendMinimalSummary(ctx, sessionID, totalPruned, tokensSaved, sessionStats, agent)
        return
    }

    await sendDetailedSummary(ctx, sessionID, llmPrunedIds, toolMetadata, tokensSaved, sessionStats, agent)
}

async function sendMinimalSummary(
    ctx: NotificationContext,
    sessionID: string,
    totalPruned: number,
    tokensSaved: number,
    sessionStats: SessionStats,
    agent?: string
): Promise<void> {
    if (totalPruned === 0) return

    const tokensFormatted = formatTokenCount(tokensSaved)
    const toolText = totalPruned === 1 ? 'tool' : 'tools'

    let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${totalPruned} ${toolText} pruned)`

    if (sessionStats.totalToolsPruned > totalPruned) {
        message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
    }

    await sendIgnoredMessage(ctx, sessionID, message, agent)
}

async function sendDetailedSummary(
    ctx: NotificationContext,
    sessionID: string,
    llmPrunedIds: string[],
    toolMetadata: Map<string, { tool: string, parameters?: any }>,
    tokensSaved: number,
    sessionStats: SessionStats,
    agent?: string
): Promise<void> {
    const totalPruned = llmPrunedIds.length
    const tokensFormatted = formatTokenCount(tokensSaved)

    let message = `🧹 DCP: Saved ~${tokensFormatted} tokens (${totalPruned} tool${totalPruned > 1 ? 's' : ''} pruned)`

    if (sessionStats.totalToolsPruned > totalPruned) {
        message += ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} tokens, ${sessionStats.totalToolsPruned} tools`
    }
    message += '\n'

    message += `\n🤖 LLM analysis (${llmPrunedIds.length}):\n`
    const toolsSummary = buildToolsSummary(llmPrunedIds, toolMetadata, ctx.config.workingDirectory)

    for (const [toolName, params] of toolsSummary.entries()) {
        if (params.length > 0) {
            message += `  ${toolName} (${params.length}):\n`
            for (const param of params) {
                message += `    ${param}\n`
            }
        }
    }

    const foundToolNames = new Set(toolsSummary.keys())
    const missingTools = llmPrunedIds.filter(id => {
        const normalizedId = id.toLowerCase()
        const metadata = toolMetadata.get(normalizedId)
        return !metadata || !foundToolNames.has(metadata.tool)
    })

    if (missingTools.length > 0) {
        message += `  (${missingTools.length} tool${missingTools.length > 1 ? 's' : ''} with unknown metadata)\n`
    }

    await sendIgnoredMessage(ctx, sessionID, message.trim(), agent)
}

// ============================================================================
// Formatting for tool output
// ============================================================================

export function formatPruningResultForTool(
    result: PruningResult,
    workingDirectory?: string
): string {
    const lines: string[] = []
    lines.push(`Context pruning complete. Pruned ${result.prunedCount} tool outputs.`)
    lines.push('')

    if (result.llmPrunedIds.length > 0) {
        lines.push(`Semantically pruned (${result.llmPrunedIds.length}):`)
        const toolsSummary = buildToolsSummary(result.llmPrunedIds, result.toolMetadata, workingDirectory)
        lines.push(...formatToolSummaryLines(toolsSummary))
    }

    return lines.join('\n').trim()
}

// ============================================================================
// Summary building helpers
// ============================================================================

export function buildToolsSummary(
    prunedIds: string[],
    toolMetadata: Map<string, { tool: string, parameters?: any }>,
    workingDirectory?: string
): Map<string, string[]> {
    const toolsSummary = new Map<string, string[]>()

    for (const prunedId of prunedIds) {
        const normalizedId = prunedId.toLowerCase()
        const metadata = toolMetadata.get(normalizedId)
        if (metadata) {
            const toolName = metadata.tool
            if (!toolsSummary.has(toolName)) {
                toolsSummary.set(toolName, [])
            }

            const paramKey = extractParameterKey(metadata)
            if (paramKey) {
                const displayKey = truncate(shortenPath(paramKey, workingDirectory), 80)
                toolsSummary.get(toolName)!.push(displayKey)
            } else {
                toolsSummary.get(toolName)!.push('(default)')
            }
        }
    }

    return toolsSummary
}

export function formatToolSummaryLines(
    toolsSummary: Map<string, string[]>,
    indent: string = '  '
): string[] {
    const lines: string[] = []

    for (const [toolName, params] of toolsSummary.entries()) {
        if (params.length === 1) {
            lines.push(`${indent}${toolName}: ${params[0]}`)
        } else if (params.length > 1) {
            lines.push(`${indent}${toolName} (${params.length}):`)
            for (const param of params) {
                lines.push(`${indent}  ${param}`)
            }
        }
    }

    return lines
}

// ============================================================================
// Path utilities
// ============================================================================

function truncate(str: string, maxLen: number = 60): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + '...'
}

function shortenPath(input: string, workingDirectory?: string): string {
    const inPathMatch = input.match(/^(.+) in (.+)$/)
    if (inPathMatch) {
        const prefix = inPathMatch[1]
        const pathPart = inPathMatch[2]
        const shortenedPath = shortenSinglePath(pathPart, workingDirectory)
        return `${prefix} in ${shortenedPath}`
    }

    return shortenSinglePath(input, workingDirectory)
}

function shortenSinglePath(path: string, workingDirectory?: string): string {
    const homeDir = require('os').homedir()

    if (workingDirectory) {
        if (path.startsWith(workingDirectory + '/')) {
            return path.slice(workingDirectory.length + 1)
        }
        if (path === workingDirectory) {
            return '.'
        }
    }

    if (path.startsWith(homeDir)) {
        path = '~' + path.slice(homeDir.length)
    }

    const nodeModulesMatch = path.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)\/(.*)/)
    if (nodeModulesMatch) {
        return `${nodeModulesMatch[1]}/${nodeModulesMatch[2]}`
    }

    if (workingDirectory) {
        const workingDirWithTilde = workingDirectory.startsWith(homeDir)
            ? '~' + workingDirectory.slice(homeDir.length)
            : null

        if (workingDirWithTilde && path.startsWith(workingDirWithTilde + '/')) {
            return path.slice(workingDirWithTilde.length + 1)
        }
        if (workingDirWithTilde && path === workingDirWithTilde) {
            return '.'
        }
    }

    return path
}
