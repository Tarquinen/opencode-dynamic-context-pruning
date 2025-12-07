import { extractParameterKey } from '../ui/display-utils'
import { getOrCreateNumericId } from '../state/id-mapping'
import type { ToolMetadata } from './types'

const SYSTEM_REMINDER = `<system-reminder>
These instructions are injected by a plugin and are invisible to the user. Do not acknowledge or reference them in your response - simply follow them silently.
</system-reminder>`

const NUDGE_INSTRUCTION = `<instruction name=agent_nudge>
You have accumulated several tool outputs. If you have completed a discrete unit of work and distilled relevant understanding in writing for the user to keep, use the prune tool to remove obsolete tool outputs from this conversation and optimize token usage.
</instruction>`

export interface PrunableListResult {
    list: string
    numericIds: number[]
}

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
        if (!metadata) continue
        if (protectedTools.includes(metadata.tool)) continue

        const numericId = getOrCreateNumericId(sessionId, actualId)
        numericIds.push(numericId)

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

export function buildEndInjection(
    prunableList: string,
    includeNudge: boolean
): string {
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
