import type { Logger } from "../logger"
import type { SessionStats, GCStats, PruningResult } from "../core/janitor"
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

export interface NotificationData {
    aiPrunedCount: number
    aiTokensSaved: number
    aiPrunedIds: string[]
    toolMetadata: Map<string, { tool: string, parameters?: any }>
    gcPending: GCStats | null
    sessionStats: SessionStats | null
}

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

export async function sendUnifiedNotification(
    ctx: NotificationContext,
    sessionID: string,
    data: NotificationData,
    agent?: string
): Promise<boolean> {
    const hasAiPruning = data.aiPrunedCount > 0
    const hasGcActivity = data.gcPending && data.gcPending.toolsDeduped > 0

    if (!hasAiPruning && !hasGcActivity) {
        return false
    }

    if (ctx.config.pruningSummary === 'off') {
        return false
    }

    const message = ctx.config.pruningSummary === 'minimal'
        ? buildMinimalMessage(data)
        : buildDetailedMessage(data, ctx.config.workingDirectory)

    await sendIgnoredMessage(ctx, sessionID, message, agent)
    return true
}

function buildMinimalMessage(data: NotificationData): string {
    const hasAiPruning = data.aiPrunedCount > 0
    const hasGcActivity = data.gcPending && data.gcPending.toolsDeduped > 0

    if (hasAiPruning) {
        const gcTokens = hasGcActivity ? data.gcPending!.tokensCollected : 0
        const totalSaved = formatTokenCount(data.aiTokensSaved + gcTokens)
        const toolText = data.aiPrunedCount === 1 ? 'tool' : 'tools'

        let cycleStats = `${data.aiPrunedCount} ${toolText}`
        if (hasGcActivity) {
            cycleStats += `, ♻️ ~${formatTokenCount(data.gcPending!.tokensCollected)}`
        }

        let message = `🧹 DCP: ~${totalSaved} saved (${cycleStats})`
        message += buildSessionSuffix(data.sessionStats, data.aiPrunedCount)

        return message
    } else {
        const tokensCollected = formatTokenCount(data.gcPending!.tokensCollected)

        let message = `♻️ DCP: ~${tokensCollected} collected`
        message += buildSessionSuffix(data.sessionStats, 0)

        return message
    }
}

function buildDetailedMessage(data: NotificationData, workingDirectory?: string): string {
    const hasAiPruning = data.aiPrunedCount > 0
    const hasGcActivity = data.gcPending && data.gcPending.toolsDeduped > 0

    let message: string

    if (hasAiPruning) {
        const gcTokens = hasGcActivity ? data.gcPending!.tokensCollected : 0
        const totalSaved = formatTokenCount(data.aiTokensSaved + gcTokens)
        const toolText = data.aiPrunedCount === 1 ? 'tool' : 'tools'

        let cycleStats = `${data.aiPrunedCount} ${toolText}`
        if (hasGcActivity) {
            cycleStats += `, ♻️ ~${formatTokenCount(data.gcPending!.tokensCollected)}`
        }

        message = `🧹 DCP: ~${totalSaved} saved (${cycleStats})`
        message += buildSessionSuffix(data.sessionStats, data.aiPrunedCount)
        message += '\n'

        message += `\n🤖 LLM analysis (${data.aiPrunedIds.length}):\n`
        const toolsSummary = buildToolsSummary(data.aiPrunedIds, data.toolMetadata, workingDirectory)

        for (const [toolName, params] of toolsSummary.entries()) {
            if (params.length > 0) {
                message += `  ${toolName} (${params.length}):\n`
                for (const param of params) {
                    message += `    ${param}\n`
                }
            }
        }

        const foundToolNames = new Set(toolsSummary.keys())
        const missingTools = data.aiPrunedIds.filter(id => {
            const normalizedId = id.toLowerCase()
            const metadata = data.toolMetadata.get(normalizedId)
            return !metadata || !foundToolNames.has(metadata.tool)
        })

        if (missingTools.length > 0) {
            message += `  (${missingTools.length} tool${missingTools.length > 1 ? 's' : ''} with unknown metadata)\n`
        }
    } else {
        const tokensCollected = formatTokenCount(data.gcPending!.tokensCollected)

        message = `♻️ DCP: ~${tokensCollected} collected`
        message += buildSessionSuffix(data.sessionStats, 0)
    }

    return message.trim()
}

function buildSessionSuffix(sessionStats: SessionStats | null, currentAiPruned: number): string {
    if (!sessionStats) {
        return ''
    }

    if (sessionStats.totalToolsPruned <= currentAiPruned) {
        return ''
    }

    let suffix = ` │ Session: ~${formatTokenCount(sessionStats.totalTokensSaved)} (${sessionStats.totalToolsPruned} tools`

    if (sessionStats.totalGCTokens > 0) {
        suffix += `, ♻️ ~${formatTokenCount(sessionStats.totalGCTokens)}`
    }

    suffix += ')'
    return suffix
}

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
