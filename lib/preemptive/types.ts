/**
 * Types for preemptive compaction feature
 */

export interface PreemptiveCompactionState {
    lastCompactionTime: Map<string, number>
    compactionInProgress: Set<string>
}

export interface TokenInfo {
    input: number
    output: number
    cache: {
        read: number
        write: number
    }
}

export interface MessageInfo {
    id: string
    role: string
    sessionID: string
    providerID?: string
    modelID?: string
    tokens?: TokenInfo
    summary?: boolean
    finish?: boolean
}

export interface TruncationResult {
    success: boolean
    sufficient: boolean
    truncatedCount: number
    totalBytesRemoved: number
    targetBytesToRemove: number
    truncatedTools: Array<{ toolName: string; originalSize: number }>
}

export interface ToolResultInfo {
    partPath: string
    partId: string
    messageID: string
    toolName: string
    outputSize: number
}

export interface StoredToolPart {
    id: string
    sessionID: string
    messageID: string
    type: "tool"
    callID: string
    tool: string
    state: {
        status: "pending" | "running" | "completed" | "error"
        input: Record<string, unknown>
        output?: string
        error?: string
        time?: {
            start: number
            end?: number
            compacted?: number
        }
    }
    truncated?: boolean
    originalSize?: number
}

export interface PreemptiveCompactionConfig {
    enabled: boolean
    threshold: number
    cooldownMs: number
    minTokens: number
    truncation: {
        enabled: boolean
        protectedMessages: number
    }
}

export interface CompactionPhaseResult {
    phase: "triggered" | "dcp" | "truncation" | "decision" | "skipped" | "summarized"
    data: Record<string, unknown>
}
