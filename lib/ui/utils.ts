import { SessionState, ToolParameterEntry, WithParts } from "../state"
import { countTokens } from "../token-utils"
import { isIgnoredUserMessage } from "../messages/query"

function extractParameterKey(tool: string, parameters: any): string {
    if (!parameters) return ""

    if (tool === "read" && parameters.filePath) {
        const offset = parameters.offset
        const limit = parameters.limit
        if (offset !== undefined && limit !== undefined) {
            return `${parameters.filePath} (lines ${offset}-${offset + limit})`
        }
        if (offset !== undefined) {
            return `${parameters.filePath} (lines ${offset}+)`
        }
        if (limit !== undefined) {
            return `${parameters.filePath} (lines 0-${limit})`
        }
        return parameters.filePath
    }

    if ((tool === "write" || tool === "edit" || tool === "multiedit") && parameters.filePath) {
        return parameters.filePath
    }

    if (tool === "apply_patch" && typeof parameters.patchText === "string") {
        const pathRegex = /\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g
        const paths: string[] = []
        let match
        while ((match = pathRegex.exec(parameters.patchText)) !== null) {
            paths.push(match[1].trim())
        }
        if (paths.length > 0) {
            const uniquePaths = [...new Set(paths)]
            const count = uniquePaths.length
            const plural = count > 1 ? "s" : ""
            if (count === 1) return uniquePaths[0]
            if (count === 2) return uniquePaths.join(", ")
            return `${count} file${plural}: ${uniquePaths[0]}, ${uniquePaths[1]}...`
        }
        return "patch"
    }

    if (tool === "list") {
        return parameters.path || "(current directory)"
    }

    if (tool === "glob") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return "(unknown pattern)"
    }

    if (tool === "grep") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return "(unknown pattern)"
    }

    if (tool === "bash") {
        if (parameters.description) return parameters.description
        if (parameters.command) {
            return parameters.command.length > 50
                ? parameters.command.substring(0, 50) + "..."
                : parameters.command
        }
    }

    if (tool === "webfetch" && parameters.url) {
        return parameters.url
    }
    if (tool === "websearch" && parameters.query) {
        return `"${parameters.query}"`
    }
    if (tool === "codesearch" && parameters.query) {
        return `"${parameters.query}"`
    }

    if (tool === "todowrite") {
        return `${parameters.todos?.length || 0} todos`
    }
    if (tool === "todoread") {
        return "read todo list"
    }

    if (tool === "task" && parameters.description) {
        return parameters.description
    }
    if (tool === "skill" && parameters.name) {
        return parameters.name
    }

    if (tool === "lsp") {
        const op = parameters.operation || "lsp"
        const path = parameters.filePath || ""
        const line = parameters.line
        const char = parameters.character
        if (path && line !== undefined && char !== undefined) {
            return `${op} ${path}:${line}:${char}`
        }
        if (path) {
            return `${op} ${path}`
        }
        return op
    }

    if (tool === "question") {
        const questions = parameters.questions
        if (Array.isArray(questions) && questions.length > 0) {
            const headers = questions
                .map((q: any) => q.header || "")
                .filter(Boolean)
                .slice(0, 3)

            const count = questions.length
            const plural = count > 1 ? "s" : ""

            if (headers.length > 0) {
                const suffix = count > 3 ? ` (+${count - 3} more)` : ""
                return `${count} question${plural}: ${headers.join(", ")}${suffix}`
            }
            return `${count} question${plural}`
        }
        return "question"
    }

    const paramStr = JSON.stringify(parameters)
    if (paramStr === "{}" || paramStr === "[]" || paramStr === "null") {
        return ""
    }

    return paramStr.substring(0, 50)
}

export function formatStatsHeader(totalTokensSaved: number, pruneTokenCounter: number): string {
    const totalTokensSavedStr = `~${formatTokenCount(totalTokensSaved + pruneTokenCounter)}`
    return [`▣ DCP | ${totalTokensSavedStr} saved total`].join("\n")
}

/**
 * Every DCP chat notification carries this marker. The V2 request view uses it
 * to keep UI notifications out of the model's context, since the V2 host never
 * strips `ignored` parts. Only the marker prefix matches: manual-trigger
 * prompts start with their own marker (<compress triggered manually>) and must
 * stay visible to the model.
 */
export const DCP_CHAT_MARKER = "▣ DCP"

export function isDcpChatText(text: string | undefined | null): boolean {
    return !!text && text.startsWith(DCP_CHAT_MARKER)
}

export function formatTokenCount(tokens: number, compact?: boolean): string {
    const suffix = compact ? "" : " tokens"
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + suffix
    }
    return tokens.toString() + suffix
}

export function truncate(str: string, maxLen: number = 60): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + "..."
}

export function formatProgressBar(
    messageIds: string[],
    prunedMessages: Map<string, number>,
    recentMessageIds: string[],
    width: number = 50,
): string {
    const ACTIVE = "█"
    const PRUNED = "░"
    const RECENT = "⣿"
    const recentSet = new Set(recentMessageIds)

    const total = messageIds.length
    if (total === 0) return `│${PRUNED.repeat(width)}│`

    const bar = new Array(width).fill(ACTIVE)

    for (let m = 0; m < total; m++) {
        const msgId = messageIds[m]
        const start = Math.floor((m / total) * width)
        const end = Math.floor(((m + 1) / total) * width)

        if (recentSet.has(msgId)) {
            for (let i = start; i < end; i++) {
                bar[i] = RECENT
            }
        } else if (prunedMessages.has(msgId)) {
            for (let i = start; i < end; i++) {
                bar[i] = PRUNED
            }
        }
    }

    return `│${bar.join("")}│`
}

export function cacheSystemPromptTokens(state: SessionState, messages: WithParts[]): void {
    let firstInputTokens = 0
    for (const msg of messages) {
        if (msg.info.role !== "assistant") {
            continue
        }
        const info = msg.info as any
        const input = info?.tokens?.input || 0
        const cacheRead = info?.tokens?.cache?.read || 0
        const cacheWrite = info?.tokens?.cache?.write || 0
        if (input > 0 || cacheRead > 0 || cacheWrite > 0) {
            firstInputTokens = input + cacheRead + cacheWrite
            break
        }
    }

    if (firstInputTokens <= 0) {
        state.systemPromptTokens = undefined
        return
    }

    let firstUserText = ""
    for (const msg of messages) {
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text" && !(part as any).ignored) {
                firstUserText += part.text
            }
        }
        break
    }

    const estimatedSystemTokens = Math.max(0, firstInputTokens - countTokens(firstUserText))
    state.systemPromptTokens = estimatedSystemTokens > 0 ? estimatedSystemTokens : undefined
}

export function shortenPath(input: string, workingDirectory?: string): string {
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
    if (workingDirectory) {
        if (path.startsWith(workingDirectory + "/")) {
            return path.slice(workingDirectory.length + 1)
        }
        if (path === workingDirectory) {
            return "."
        }
    }

    return path
}

export function formatPrunedItemsList(
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string[] {
    const lines: string[] = []

    for (const id of pruneToolIds) {
        const metadata = toolMetadata.get(id)

        if (metadata) {
            const paramKey = extractParameterKey(metadata.tool, metadata.parameters)
            if (paramKey) {
                // Use 60 char limit to match notification style
                const displayKey = truncate(shortenPath(paramKey, workingDirectory), 60)
                lines.push(`→ ${metadata.tool}: ${displayKey}`)
            } else {
                lines.push(`→ ${metadata.tool}`)
            }
        }
    }

    const knownCount = pruneToolIds.filter((id) => toolMetadata.has(id)).length
    const unknownCount = pruneToolIds.length - knownCount

    if (unknownCount > 0) {
        lines.push(`→ (${unknownCount} tool${unknownCount > 1 ? "s" : ""} with unknown metadata)`)
    }

    return lines
}

export function formatPruningResultForTool(
    prunedIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string {
    const lines: string[] = []
    lines.push(`Context pruning complete. Pruned ${prunedIds.length} tool outputs.`)
    lines.push("")

    if (prunedIds.length > 0) {
        lines.push(`Semantically pruned (${prunedIds.length}):`)
        lines.push(...formatPrunedItemsList(prunedIds, toolMetadata, workingDirectory))
    }

    return lines.join("\n").trim()
}
