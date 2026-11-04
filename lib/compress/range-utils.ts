import type { CompressionBlock, ProtectedContent, SessionState } from "../state"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import type { IdFormat } from "../message-ids"
import { getBlockProtectedContent, renderProtectedContent } from "./protected-content"
import type {
    BoundaryReference,
    CompressRangeToolArgs,
    InjectedSummaryResult,
    ParsedBlockPlaceholder,
    ResolvedRangeCompression,
    SearchContext,
} from "./types"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

const CONDENSED_BLOCK_REF_PREFIX = "[condensed block"

function formatCondensedBlockRef(blockId: number): string {
    return `${CONDENSED_BLOCK_REF_PREFIX} b${blockId}]`
}

export function validateArgs(args: CompressRangeToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
            throw new Error(`${prefix}.startId is required and must be a non-empty string`)
        }

        if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
            throw new Error(`${prefix}.endId is required and must be a non-empty string`)
        }

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

export function resolveRanges(
    args: CompressRangeToolArgs,
    searchContext: SearchContext,
    state: SessionState,
): ResolvedRangeCompression[] {
    return args.content.map((entry, index) => {
        const normalizedEntry = {
            startId: entry.startId.trim(),
            endId: entry.endId.trim(),
            summary: entry.summary,
        }

        const { startReference, endReference } = resolveBoundaryIds(
            searchContext,
            state,
            normalizedEntry.startId,
            normalizedEntry.endId,
        )
        const selection = resolveSelection(searchContext, startReference, endReference)

        return {
            index,
            entry: normalizedEntry,
            selection,
            anchorMessageId: resolveAnchorMessageId(startReference),
        }
    })
}

export function validateNonOverlapping(plans: ResolvedRangeCompression[]): void {
    const sortedPlans = [...plans].sort(
        (left, right) =>
            left.selection.startReference.rawIndex - right.selection.startReference.rawIndex ||
            left.selection.endReference.rawIndex - right.selection.endReference.rawIndex ||
            left.index - right.index,
    )

    const issues: string[] = []

    for (let index = 1; index < sortedPlans.length; index++) {
        const previous = sortedPlans[index - 1]
        const current = sortedPlans[index]
        if (!previous || !current) {
            continue
        }

        if (current.selection.startReference.rawIndex > previous.selection.endReference.rawIndex) {
            continue
        }

        issues.push(
            `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps content[${current.index}] (${current.entry.startId}..${current.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }
}

export function parseBlockPlaceholders(
    summary: string,
    format: IdFormat = "xml",
): ParsedBlockPlaceholder[] {
    const placeholders: ParsedBlockPlaceholder[] = []
    const regex = format === "compact" ? /@b([1-9]\d*)@/gi : new RegExp(BLOCK_PLACEHOLDER_REGEX)

    let match: RegExpExecArray | null
    while ((match = regex.exec(summary)) !== null) {
        const full = match[0]
        const blockIdPart = match[1] || match[2]
        const parsed = Number.parseInt(blockIdPart, 10)
        if (!Number.isInteger(parsed)) {
            continue
        }

        placeholders.push({
            raw: full,
            blockId: parsed,
            startIndex: match.index,
            endIndex: match.index + full.length,
        })
    }

    return placeholders
}

export function validateSummaryPlaceholders(
    placeholders: ParsedBlockPlaceholder[],
    requiredBlockIds: number[],
    startReference: BoundaryReference,
    endReference: BoundaryReference,
    summaryByBlockId: Map<number, CompressionBlock>,
): number[] {
    const boundaryOptionalIds = new Set<number>()
    if (startReference.kind === "compressed-block") {
        if (startReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(startReference.blockId)
    }
    if (endReference.kind === "compressed-block") {
        if (endReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(endReference.blockId)
    }

    const strictRequiredIds = requiredBlockIds.filter((id) => !boundaryOptionalIds.has(id))
    const requiredSet = new Set(requiredBlockIds)
    const keptPlaceholderIds = new Set<number>()
    const validPlaceholders: ParsedBlockPlaceholder[] = []

    for (const placeholder of placeholders) {
        const isKnown = summaryByBlockId.has(placeholder.blockId)
        const isRequired = requiredSet.has(placeholder.blockId)
        const isDuplicate = keptPlaceholderIds.has(placeholder.blockId)

        if (isKnown && isRequired && !isDuplicate) {
            validPlaceholders.push(placeholder)
            keptPlaceholderIds.add(placeholder.blockId)
        }
    }

    placeholders.length = 0
    placeholders.push(...validPlaceholders)

    return strictRequiredIds.filter((id) => !keptPlaceholderIds.has(id))
}

function collectBlockProtectedContent(
    blockIds: number[],
    summaryByBlockId: Map<number, CompressionBlock>,
): ProtectedContent[] {
    const entries: ProtectedContent[] = []
    for (const blockId of blockIds) {
        const target = summaryByBlockId.get(blockId)
        if (!target) {
            continue
        }
        entries.push(...getBlockProtectedContent(target))
    }

    const seen = new Set<string>()
    const deduped: ProtectedContent[] = []
    for (const entry of entries) {
        const key = `${entry.kind}:${entry.text}`
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        deduped.push(entry)
    }
    return deduped
}

export function injectBlockPlaceholders(
    summary: string,
    placeholders: ParsedBlockPlaceholder[],
    summaryByBlockId: Map<number, CompressionBlock>,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
    condense = false,
): InjectedSummaryResult {
    let cursor = 0
    let expanded = summary
    const consumed: number[] = []
    const consumedSeen = new Set<number>()
    const preservedSections: string[] = []
    const preservedProtected: ProtectedContent[] = []

    if (placeholders.length > 0) {
        expanded = ""
        for (const placeholder of placeholders) {
            const target = summaryByBlockId.get(placeholder.blockId)
            if (!target) {
                throw new Error(`Compressed block not found: (b${placeholder.blockId})`)
            }

            expanded += summary.slice(cursor, placeholder.startIndex)
            if (condense) {
                expanded += formatCondensedBlockRef(placeholder.blockId)
                preservedProtected.push(...getBlockProtectedContent(target))
            } else {
                expanded += restoreSummary(target.summary)
                preservedProtected.push(...getBlockProtectedContent(target))
            }
            cursor = placeholder.endIndex

            if (!consumedSeen.has(placeholder.blockId)) {
                consumedSeen.add(placeholder.blockId)
                consumed.push(placeholder.blockId)
            }
        }

        expanded += summary.slice(cursor)
    }

    expanded = injectBoundarySummary(
        expanded,
        startReference,
        "start",
        summaryByBlockId,
        consumed,
        consumedSeen,
        condense,
        preservedSections,
        preservedProtected,
    )
    expanded = injectBoundarySummary(
        expanded,
        endReference,
        "end",
        summaryByBlockId,
        consumed,
        consumedSeen,
        condense,
        preservedSections,
        preservedProtected,
    )

    if (preservedSections.length > 0) {
        expanded = `${expanded}\n\n${preservedSections.join("\n\n")}`
    } else if (condense && preservedProtected.length > 0) {
        const rendered = renderProtectedContent(preservedProtected)
        if (rendered) {
            expanded = `${expanded}\n\n${rendered}`
        }
    }

    const protectedContent = collectBlockProtectedContent(consumed, summaryByBlockId)

    return {
        expandedSummary: expanded,
        consumedBlockIds: consumed,
        protectedContent,
    }
}

export function appendMissingBlockSummaries(
    summary: string,
    missingBlockIds: number[],
    summaryByBlockId: Map<number, CompressionBlock>,
    consumedBlockIds: number[],
    format: IdFormat = "xml",
    condense = false,
): InjectedSummaryResult {
    const consumedSeen = new Set<number>(consumedBlockIds)
    const consumed = [...consumedBlockIds]

    const missingSummaries: string[] = []
    const protectedEntries: ProtectedContent[] = []
    for (const blockId of missingBlockIds) {
        if (consumedSeen.has(blockId)) {
            continue
        }

        const target = summaryByBlockId.get(blockId)
        if (!target) {
            throw new Error(`Compressed block not found: (b${blockId})`)
        }

        const label = format === "compact" ? `compressed block ${blockId}` : `(b${blockId})`
        const blockProtected = getBlockProtectedContent(target)
        protectedEntries.push(...blockProtected)

        if (condense) {
            if (blockProtected.length > 0) {
                missingSummaries.push(`\n### ${label}\n${renderProtectedContent(blockProtected)}`)
            } else {
                missingSummaries.push(`\n### ${label}\n${formatCondensedBlockRef(blockId)}`)
            }
        } else {
            missingSummaries.push(`\n### ${label}\n${restoreSummary(target.summary)}`)
        }
        consumedSeen.add(blockId)
        consumed.push(blockId)
    }

    if (missingSummaries.length === 0) {
        return {
            expandedSummary: summary,
            consumedBlockIds: consumed,
            protectedContent: protectedEntries,
        }
    }

    const heading =
        "\n\nThe following previously compressed summaries were also part of this conversation section:"

    return {
        expandedSummary: summary + heading + missingSummaries.join(""),
        consumedBlockIds: consumed,
        protectedContent: protectedEntries,
    }
}

function restoreSummary(summary: string): string {
    const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i)
    if (!headerMatch) {
        return summary
    }

    const afterHeader = summary.slice(headerMatch[0].length)
    const withoutLeadingBreaks = afterHeader.replace(/^(?:\r?\n)+/, "")
    return withoutLeadingBreaks
        .replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "")
        .replace(/(?:\r?\n)*@b[1-9]\d*@\s*$/i, "")
        .replace(/(?:\r?\n)+$/, "")
}

function injectBoundarySummary(
    summary: string,
    reference: BoundaryReference,
    position: "start" | "end",
    summaryByBlockId: Map<number, CompressionBlock>,
    consumed: number[],
    consumedSeen: Set<number>,
    condense = false,
    preservedSections: string[] = [],
    preservedProtected: ProtectedContent[] = [],
): string {
    if (reference.kind !== "compressed-block" || reference.blockId === undefined) {
        return summary
    }
    if (consumedSeen.has(reference.blockId)) {
        return summary
    }

    const target = summaryByBlockId.get(reference.blockId)
    if (!target) {
        throw new Error(`Compressed block not found: (b${reference.blockId})`)
    }

    if (condense) {
        preservedProtected.push(...getBlockProtectedContent(target))
        const injectedBody = formatCondensedBlockRef(reference.blockId)
        const left = position === "start" ? injectedBody.trim() : summary.trim()
        const right = position === "start" ? summary.trim() : injectedBody.trim()
        const next = !left ? right : !right ? left : `${left}\n\n${right}`
        consumedSeen.add(reference.blockId)
        consumed.push(reference.blockId)
        return next
    }

    preservedProtected.push(...getBlockProtectedContent(target))
    const injectedBody = restoreSummary(target.summary)
    const left = position === "start" ? injectedBody.trim() : summary.trim()
    const right = position === "start" ? summary.trim() : injectedBody.trim()
    const next = !left ? right : !right ? left : `${left}\n\n${right}`

    consumedSeen.add(reference.blockId)
    consumed.push(reference.blockId)
    return next
}

export function isSummaryShrinkViolation(summaryTokens: number, compressedTokens: number): boolean {
    return compressedTokens > 0 && summaryTokens >= compressedTokens
}
