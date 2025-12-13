import type { WithParts } from "../state"

/**
 * Extracts a human-readable key from tool metadata for display purposes.
 * Used by both deduplication and AI analysis to show what was pruned.
 */
export const extractParameterKey = (tool: string, parameters: any): string => {
    if (!parameters) return ''

    if (tool === "read" && parameters.filePath) {
        return parameters.filePath
    }
    if (tool === "write" && parameters.filePath) {
        return parameters.filePath
    }
    if (tool === "edit" && parameters.filePath) {
        return parameters.filePath
    }

    if (tool === "list") {
        return parameters.path || '(current directory)'
    }
    if (tool === "glob") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return '(unknown pattern)'
    }
    if (tool === "grep") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return '(unknown pattern)'
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

    const paramStr = JSON.stringify(parameters)
    if (paramStr === '{}' || paramStr === '[]' || paramStr === 'null') {
        return ''
    }
    return paramStr.substring(0, 50)
}

export const getLastUserMessage = (
    messages: WithParts[]
): WithParts | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === 'user') {
            return msg
        }
    }
    return null
}
