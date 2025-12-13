import { Message, Part } from "@opencode-ai/sdk"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    compacted?: boolean
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface Prune {
    toolIds: string[]
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    prune: Prune
    stats: SessionStats
    toolParameters: Map<string, ToolParameterEntry>
    nudgeCounter: number
    lastToolPrune: boolean
}
