import type { PluginState } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { ToolTracker } from "./tool-tracker"
export type { ToolTracker } from "./tool-tracker"

// ============================================================================
// Format Descriptor Interface
// ============================================================================

/** Represents a tool output that can be pruned */
export interface ToolOutput {
    /** The tool call ID (tool_call_id, call_id, tool_use_id, or position key for Gemini) */
    id: string
    /** The tool name (for protected tool checking) */
    toolName?: string
}

/**
 * Describes how to handle a specific API format (OpenAI Chat, Anthropic, Gemini, etc.)
 * Each format implements this interface to provide format-specific logic.
 */
export interface FormatDescriptor {
    /** Human-readable name for logging */
    name: string

    /** Check if this format matches the request body */
    detect(body: any): boolean

    /** Get the data array to process (messages, contents, input, etc.) */
    getDataArray(body: any): any[] | undefined

    /** Cache tool parameters from the data array */
    cacheToolParameters(data: any[], state: PluginState, logger?: Logger): void

    /** Inject synthetic instruction into the last user message */
    injectSynth(data: any[], instruction: string, nudgeText: string): boolean

    /** Track new tool results for nudge frequency */
    trackNewToolResults(data: any[], tracker: ToolTracker, protectedTools: Set<string>): number

    /** Inject prunable list at end of conversation */
    injectPrunableList(data: any[], injection: string): boolean

    /** Extract all tool outputs from the data for pruning */
    extractToolOutputs(data: any[], state: PluginState): ToolOutput[]

    /** Replace a pruned tool output with the pruned message. Returns true if replaced. */
    replaceToolOutput(data: any[], toolId: string, prunedMessage: string, state: PluginState): boolean

    /** Check if data has any tool outputs worth processing */
    hasToolOutputs(data: any[]): boolean

    /** Get metadata for logging after replacements */
    getLogMetadata(data: any[], replacedCount: number, inputUrl: string): Record<string, any>
}

/** Prompts used for synthetic instruction injection */
export interface SynthPrompts {
    synthInstruction: string
    nudgeInstruction: string
}

/** Context passed to each format-specific handler */
export interface FetchHandlerContext {
    state: PluginState
    logger: Logger
    client: any
    config: PluginConfig
    toolTracker: ToolTracker
    prompts: SynthPrompts
}

/** Result from a format handler indicating what happened */
export interface FetchHandlerResult {
    /** Whether the body was modified and should be re-serialized */
    modified: boolean
    /** The potentially modified body object */
    body: any
}

/** Session data returned from getAllPrunedIds */
export interface PrunedIdData {
    allSessions: any
    allPrunedIds: Set<string>
}
