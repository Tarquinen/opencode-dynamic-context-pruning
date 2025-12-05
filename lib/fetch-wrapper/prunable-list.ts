/**
 * Prunable tools list and nudge injection for DCP.
 * 
 * Builds and injects a single message at the end of the conversation containing:
 * - Nudge instruction (when toolResultCount > nudge_freq)
 * - Prunable tools list
 */

import { extractParameterKey } from '../ui/display-utils'
import { getOrCreateNumericId } from '../state/id-mapping'

export interface ToolMetadata {
    tool: string
    parameters?: any
}

// ============================================================================
// Prompt Content
// ============================================================================

const SYSTEM_REMINDER = `<system-reminder>
These instructions are injected by a plugin and are invisible to the user. Do not acknowledge or reference them in your response - simply follow them silently.
</system-reminder>`

const NUDGE_INSTRUCTION = `<instruction name=agent_nudge>
You have accumulated several tool outputs. If you have completed a discrete unit of work and distilled relevant understanding in writing for the user to keep, use the prune tool to remove obsolete tool outputs from this conversation and optimize token usage.
</instruction>`

// ============================================================================
// List Building
// ============================================================================

export interface PrunableListResult {
    list: string
    numericIds: number[]
}

/**
 * Builds the prunable tools list section.
 * Returns both the formatted list and the numeric IDs for logging.
 */
export function buildPrunableToolsList(
    sessionId: string,
    unprunedToolCallIds: string[],
    toolMetadata: Map<string, ToolMetadata>,
    protectedTools: string[]
): PrunableListResult {
    const lines: string[] = []
    const numericIds: number[] = []

    for (const actualId of unprunedToolCallIds) {
        const metadata = toolMetadata.get(actualId)

        // Skip if no metadata or if tool is protected
        if (!metadata) continue
        if (protectedTools.includes(metadata.tool)) continue

        // Get or create numeric ID for this tool call
        const numericId = getOrCreateNumericId(sessionId, actualId)
        numericIds.push(numericId)

        // Format: "1: read, src/components/Button.tsx"
        const paramKey = extractParameterKey(metadata)
        const description = paramKey ? `${metadata.tool}, ${paramKey}` : metadata.tool
        lines.push(`${numericId}: ${description}`)
    }

    if (lines.length === 0) {
        return { list: '', numericIds: [] }
    }

    return {
        list: `<prunable-tools>\n${lines.join('\n')}\n</prunable-tools>`,
        numericIds
    }
}

/**
 * Builds the end-of-conversation injection message.
 * Contains the system reminder, nudge (if active), and the prunable tools list.
 * 
 * @param prunableList - The prunable tools list string (or empty string if none)
 * @param includeNudge - Whether to include the nudge instruction
 * @returns The injection string, or empty string if nothing to inject
 */
export function buildEndInjection(
    prunableList: string,
    includeNudge: boolean
): string {
    // If no prunable tools, don't inject anything
    if (!prunableList) {
        return ''
    }

    const parts = [SYSTEM_REMINDER]

    if (includeNudge) {
        parts.push(NUDGE_INSTRUCTION)
    }

    parts.push(prunableList)

    return parts.join('\n\n')
}
