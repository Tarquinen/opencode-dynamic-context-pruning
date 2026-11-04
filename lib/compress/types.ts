import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { PromptStore } from "../prompts/store"
import type {
    CompressionBlock,
    CompressionMode,
    ProtectedContent,
    SessionState,
    WithParts,
} from "../state"

export interface ToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

export interface CompressRangeEntry {
    startId: string
    endId: string
    summary: string
}

export interface CompressRangeToolArgs {
    topic: string
    content: CompressRangeEntry[]
}

export interface CompressMessageEntry {
    messageId: string
    topic: string
    summary: string
}

export interface CompressMessageToolArgs {
    topic: string
    content: CompressMessageEntry[]
}

export interface BoundaryReference {
    kind: "message" | "compressed-block"
    rawIndex: number
    messageId?: string
    blockId?: number
    anchorMessageId?: string
}

export interface SearchContext {
    rawMessages: WithParts[]
    rawMessagesById: Map<string, WithParts>
    rawIndexById: Map<string, number>
    summaryByBlockId: Map<number, CompressionBlock>
}

export interface SelectionResolution {
    startReference: BoundaryReference
    endReference: BoundaryReference
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
    requiredBlockIds: number[]
}

export interface ResolvedMessageCompression {
    entry: CompressMessageEntry
    selection: SelectionResolution
    anchorMessageId: string
}

export interface ResolvedRangeCompression {
    index: number
    entry: CompressRangeEntry
    selection: SelectionResolution
    anchorMessageId: string
}

export interface ResolvedMessageCompressionsResult {
    plans: ResolvedMessageCompression[]
    skippedIssues: string[]
    skippedCount: number
}

export interface ParsedBlockPlaceholder {
    raw: string
    blockId: number
    startIndex: number
    endIndex: number
}

export interface InjectedSummaryResult {
    expandedSummary: string
    consumedBlockIds: number[]
    protectedContent: ProtectedContent[]
}

export interface AppliedCompressionResult {
    compressedTokens: number
    messageIds: string[]
    newlyCompressedMessageIds: string[]
    newlyCompressedToolIds: string[]
}

export interface CompressionStateInput {
    topic: string
    batchTopic: string
    startId: string
    endId: string
    mode: CompressionMode
    runId: number
    compressMessageId: string
    compressCallId?: string
    summaryTokens: number
}
