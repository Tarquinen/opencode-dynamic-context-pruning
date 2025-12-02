import { extractParameterKey } from "../ui/display-utils"

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

export function detectDuplicates(
    toolMetadata: Map<string, { tool: string, parameters?: any }>,
    unprunedToolCallIds: string[],  // In chronological order
    protectedTools: string[]
): DuplicateDetectionResult {
    const signatureMap = new Map<string, string[]>()

    const deduplicatableIds = unprunedToolCallIds.filter(id => {
        const metadata = toolMetadata.get(id)
        return !metadata || !protectedTools.includes(metadata.tool)
    })

    for (const id of deduplicatableIds) {
        const metadata = toolMetadata.get(id)
        if (!metadata) continue

        const signature = createToolSignature(metadata.tool, metadata.parameters)
        if (!signatureMap.has(signature)) {
            signatureMap.set(signature, [])
        }
        signatureMap.get(signature)!.push(id)
    }

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

function createToolSignature(tool: string, parameters?: any): string {
    if (!parameters) return tool

    const normalized = normalizeParameters(parameters)
    const sorted = sortObjectKeys(normalized)
    return `${tool}::${JSON.stringify(sorted)}`
}

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

function sortObjectKeys(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(sortObjectKeys)

    const sorted: any = {}
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
}
