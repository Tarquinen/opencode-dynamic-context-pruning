import { Message, Part } from "@opencode-ai/sdk"
import type { EffectiveProviderConfig } from "../config"

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
    turn: number  // Which turn (step-start count) this tool was called on
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface Prune {
    toolIds: string[]
}

export interface ProviderState {
    providerID: string | null
    modelID: string | null
    effectiveConfig: EffectiveProviderConfig | null
    lastNotifiedProvider: string | null
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    prune: Prune
    stats: SessionStats
    toolParameters: Map<string, ToolParameterEntry>
    nudgeCounter: number
    lastToolPrune: boolean
    lastCompaction: number
    currentTurn: number  // Current turn count derived from step-start parts
    provider: ProviderState
}
