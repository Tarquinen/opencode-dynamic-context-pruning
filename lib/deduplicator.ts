/**
 * Deduplicator Module
 * 
 * Handles automatic detection and removal of duplicate tool calls based on
 * tool name + parameter signature matching.
 */

export interface DuplicateDetectionResult {
    duplicateIds: string[]  // IDs to prune (older duplicates)
    deduplicationDetails: Map<string, {
        toolName: string
        parameterKey: string      // Human-readable: "file.ts" or "npm test"
        duplicateCount: number    // Total occurrences (including kept one)
        prunedIds: string[]      // Which IDs were pruned
        keptId: string           // Most recent ID (kept)
    }>
}

/**
 * Detects duplicate tool calls based on tool name + parameter signature
 * Keeps only the most recent occurrence of each duplicate set
 * Respects protected tools - they are never deduplicated
 */
export function detectDuplicates(
    toolMetadata: Map<string, { tool: string, parameters?: any }>,
    unprunedToolCallIds: string[],  // In chronological order
    protectedTools: string[]
): DuplicateDetectionResult {
    const signatureMap = new Map<string, string[]>()

    // Filter out protected tools before processing
    const deduplicatableIds = unprunedToolCallIds.filter(id => {
        const metadata = toolMetadata.get(id)
        return !metadata || !protectedTools.includes(metadata.tool)
    })

    // Build map of signature -> [ids in chronological order]
    for (const id of deduplicatableIds) {
        const metadata = toolMetadata.get(id)
        if (!metadata) continue

        const signature = createToolSignature(metadata.tool, metadata.parameters)
        if (!signatureMap.has(signature)) {
            signatureMap.set(signature, [])
        }
        signatureMap.get(signature)!.push(id)
    }

    // Identify duplicates (keep only last occurrence)
    const duplicateIds: string[] = []
    const deduplicationDetails = new Map()

    for (const [signature, ids] of signatureMap.entries()) {
        if (ids.length > 1) {
            const metadata = toolMetadata.get(ids[0])!
            const idsToRemove = ids.slice(0, -1)  // All except last
            duplicateIds.push(...idsToRemove)

            deduplicationDetails.set(signature, {
                toolName: metadata.tool,
                parameterKey: extractParameterKey(metadata),
                duplicateCount: ids.length,
                prunedIds: idsToRemove,
                keptId: ids[ids.length - 1]
            })
        }
    }

    return { duplicateIds, deduplicationDetails }
}

/**
 * Creates a deterministic signature for a tool call
 * Format: "toolName::JSON(sortedParameters)"
 */
function createToolSignature(tool: string, parameters?: any): string {
    if (!parameters) return tool

    // Normalize parameters for consistent comparison
    const normalized = normalizeParameters(parameters)
    const sorted = sortObjectKeys(normalized)
    return `${tool}::${JSON.stringify(sorted)}`
}

/**
 * Normalize parameters to handle edge cases:
 * - Remove undefined/null values
 * - Resolve relative paths to absolute (future enhancement)
 * - Sort arrays if order doesn't matter (future enhancement)
 */
function normalizeParameters(params: any): any {
    if (typeof params !== 'object' || params === null) return params
    if (Array.isArray(params)) return params

    const normalized: any = {}
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            normalized[key] = value
        }
    }
    return normalized
}

/**
 * Recursively sort object keys for deterministic comparison
 */
function sortObjectKeys(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(sortObjectKeys)

    const sorted: any = {}
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
}

/**
 * Extract human-readable parameter key for notifications
 * Supports all ACTIVE OpenCode tools with appropriate parameter extraction
 * 
 * ACTIVE Tools (always available):
 * - File: read, write, edit
 * - Search: list, glob, grep
 * - Execution: bash
 * - Agent: task
 * - Web: webfetch
 * - Todo: todowrite, todoread
 * 
 * CONDITIONAL Tools (may be disabled):
 * - batch (experimental.batch_tool flag)
 * - websearch, codesearch (OPENCODE_EXPERIMENTAL_EXA flag)
 * 
 * INACTIVE Tools (exist but not registered, skip):
 * - multiedit, patch, lsp_diagnostics, lsp_hover
 */
export function extractParameterKey(metadata: { tool: string, parameters?: any }): string {
    if (!metadata.parameters) return ''

    const { tool, parameters } = metadata

    // ===== File Operation Tools =====
    if (tool === "read" && parameters.filePath) {
        return parameters.filePath
    }
    if (tool === "write" && parameters.filePath) {
        return parameters.filePath
    }
    if (tool === "edit" && parameters.filePath) {
        return parameters.filePath
    }

    // ===== Directory/Search Tools =====
    if (tool === "list") {
        // path is optional, defaults to current directory
        return parameters.path || '(current directory)'
    }
    if (tool === "glob") {
        // pattern is required for glob
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

    // ===== Execution Tools =====
    if (tool === "bash") {
        if (parameters.description) return parameters.description
        if (parameters.command) {
            return parameters.command.length > 50
                ? parameters.command.substring(0, 50) + "..."
                : parameters.command
        }
    }

    // ===== Web Tools =====
    if (tool === "webfetch" && parameters.url) {
        return parameters.url
    }
    if (tool === "websearch" && parameters.query) {
        return `"${parameters.query}"`
    }
    if (tool === "codesearch" && parameters.query) {
        return `"${parameters.query}"`
    }

    // ===== Todo Tools =====
    // Note: Todo tools are stateful and in protectedTools by default
    if (tool === "todowrite") {
        return `${parameters.todos?.length || 0} todos`
    }
    if (tool === "todoread") {
        return "read todo list"
    }

    // ===== Agent/Task Tools =====
    // Note: task is in protectedTools by default
    if (tool === "task" && parameters.description) {
        return parameters.description
    }
    // Note: batch is experimental and needs special handling
    if (tool === "batch") {
        return `${parameters.tool_calls?.length || 0} parallel tools`
    }

    // ===== Fallback =====
    // For unknown tools, custom tools, or tools without extractable keys
    // Check if parameters is empty or only has empty values
    const paramStr = JSON.stringify(parameters)
    if (paramStr === '{}' || paramStr === '[]' || paramStr === 'null') {
        return '' // Return empty to trigger (default) fallback in UI
    }
    return paramStr.substring(0, 50)
}
