/**
 * Storage utilities for preemptive compaction
 * Handles finding and truncating tool outputs
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { TruncationResult, ToolResultInfo, StoredToolPart } from "./types"
import { TRUNCATION_MESSAGE, CHARS_PER_TOKEN } from "./constants"

// OpenCode storage directories
const OPENCODE_STORAGE = join(homedir(), ".local", "share", "opencode")
const MESSAGE_STORAGE = join(OPENCODE_STORAGE, "message")
const PART_STORAGE = join(OPENCODE_STORAGE, "part")

/**
 * Get the message directory for a session
 */
function getMessageDir(sessionID: string): string | null {
    if (!existsSync(MESSAGE_STORAGE)) return null

    // Try direct path first
    const directPath = join(MESSAGE_STORAGE, sessionID)
    if (existsSync(directPath)) return directPath

    // Search in subdirectories (for multi-project setups)
    try {
        for (const dir of readdirSync(MESSAGE_STORAGE)) {
            const sessionPath = join(MESSAGE_STORAGE, dir, sessionID)
            if (existsSync(sessionPath)) return sessionPath
        }
    } catch {
        return null
    }

    return null
}

/**
 * Get all message IDs for a session
 */
function getMessageIds(sessionID: string): string[] {
    const messageDir = getMessageDir(sessionID)
    if (!messageDir || !existsSync(messageDir)) return []

    const messageIds: string[] = []
    try {
        for (const file of readdirSync(messageDir)) {
            if (!file.endsWith(".json")) continue
            const messageId = file.replace(".json", "")
            messageIds.push(messageId)
        }
    } catch {
        return []
    }

    return messageIds
}

/**
 * Find tool results sorted by output size (largest first)
 * Optionally protects the last N messages from truncation
 */
export function findToolResultsBySize(
    sessionID: string,
    protectedMessageCount: number = 0
): ToolResultInfo[] {
    const messageIds = getMessageIds(sessionID)
    const results: ToolResultInfo[] = []

    // Protect the last N messages from truncation
    const protectedMessageIds = new Set<string>()
    if (protectedMessageCount > 0 && messageIds.length > 0) {
        const messageDir = getMessageDir(sessionID)
        if (messageDir) {
            const messageTimestamps: Array<{ id: string; mtime: number }> = []
            for (const msgId of messageIds) {
                try {
                    const msgPath = join(messageDir, `${msgId}.json`)
                    if (existsSync(msgPath)) {
                        const stat = statSync(msgPath)
                        messageTimestamps.push({ id: msgId, mtime: stat.mtimeMs })
                    }
                } catch {
                    continue
                }
            }
            // Sort by mtime descending (newest first)
            messageTimestamps.sort((a, b) => b.mtime - a.mtime)
            // Protect the most recent N messages
            for (let i = 0; i < Math.min(protectedMessageCount, messageTimestamps.length); i++) {
                protectedMessageIds.add(messageTimestamps[i].id)
            }
        }
    }

    for (const messageID of messageIds) {
        // Skip protected messages
        if (protectedMessageIds.has(messageID)) continue

        const partDir = join(PART_STORAGE, messageID)
        if (!existsSync(partDir)) continue

        try {
            for (const file of readdirSync(partDir)) {
                if (!file.endsWith(".json")) continue
                try {
                    const partPath = join(partDir, file)
                    const content = readFileSync(partPath, "utf-8")
                    const part = JSON.parse(content) as StoredToolPart

                    // Only include completed tool parts with output that aren't already truncated
                    if (part.type === "tool" && part.state?.output && !part.truncated) {
                        results.push({
                            partPath,
                            partId: part.id,
                            messageID,
                            toolName: part.tool,
                            outputSize: part.state.output.length,
                        })
                    }
                } catch {
                    continue
                }
            }
        } catch {
            continue
        }
    }

    // Sort by output size descending (largest first)
    return results.sort((a, b) => b.outputSize - a.outputSize)
}

/**
 * Find the largest tool result for a session
 */
export function findLargestToolResult(sessionID: string): ToolResultInfo | null {
    const results = findToolResultsBySize(sessionID)
    return results.length > 0 ? results[0] : null
}

/**
 * Truncate a single tool result
 */
export function truncateToolResult(partPath: string): {
    success: boolean
    toolName?: string
    originalSize?: number
} {
    try {
        const content = readFileSync(partPath, "utf-8")
        const part = JSON.parse(content) as StoredToolPart

        if (!part.state?.output) {
            return { success: false }
        }

        const originalSize = part.state.output.length
        const toolName = part.tool

        // Mark as truncated and replace output
        part.truncated = true
        part.originalSize = originalSize
        part.state.output = TRUNCATION_MESSAGE

        // Add compaction timestamp
        if (!part.state.time) {
            part.state.time = { start: Date.now() }
        }
        part.state.time.compacted = Date.now()

        writeFileSync(partPath, JSON.stringify(part, null, 2))

        return { success: true, toolName, originalSize }
    } catch {
        return { success: false }
    }
}

/**
 * Get total size of all tool outputs for a session
 */
export function getTotalToolOutputSize(sessionID: string): number {
    const results = findToolResultsBySize(sessionID)
    return results.reduce((sum, r) => sum + r.outputSize, 0)
}

/**
 * Count how many tool results have been truncated in a session
 */
export function countTruncatedResults(sessionID: string): number {
    const messageIds = getMessageIds(sessionID)
    let count = 0

    for (const messageID of messageIds) {
        const partDir = join(PART_STORAGE, messageID)
        if (!existsSync(partDir)) continue

        try {
            for (const file of readdirSync(partDir)) {
                if (!file.endsWith(".json")) continue
                try {
                    const content = readFileSync(join(partDir, file), "utf-8")
                    const part = JSON.parse(content)
                    if (part.truncated === true) {
                        count++
                    }
                } catch {
                    continue
                }
            }
        } catch {
            continue
        }
    }

    return count
}

/**
 * Truncate tool outputs until we reach the target token count
 * Returns information about what was truncated
 */
export function truncateUntilTargetTokens(
    sessionID: string,
    currentTokens: number,
    maxTokens: number,
    targetRatio: number = 0.8,
    charsPerToken: number = CHARS_PER_TOKEN,
    protectedMessageCount: number = 3
): TruncationResult {
    const targetTokens = Math.floor(maxTokens * targetRatio)
    const tokensToReduce = currentTokens - targetTokens
    const charsToReduce = tokensToReduce * charsPerToken

    // Already under target
    if (tokensToReduce <= 0) {
        return {
            success: true,
            sufficient: true,
            truncatedCount: 0,
            totalBytesRemoved: 0,
            targetBytesToRemove: 0,
            truncatedTools: [],
        }
    }

    const results = findToolResultsBySize(sessionID, protectedMessageCount)

    // No tool results to truncate
    if (results.length === 0) {
        return {
            success: false,
            sufficient: false,
            truncatedCount: 0,
            totalBytesRemoved: 0,
            targetBytesToRemove: charsToReduce,
            truncatedTools: [],
        }
    }

    let totalRemoved = 0
    let truncatedCount = 0
    const truncatedTools: Array<{ toolName: string; originalSize: number }> = []

    // Truncate largest outputs first until we've removed enough
    for (const result of results) {
        const truncateResult = truncateToolResult(result.partPath)
        if (truncateResult.success) {
            truncatedCount++
            const removedSize = truncateResult.originalSize ?? result.outputSize
            totalRemoved += removedSize
            truncatedTools.push({
                toolName: truncateResult.toolName ?? result.toolName,
                originalSize: removedSize,
            })

            // Stop if we've removed enough
            if (totalRemoved >= charsToReduce) {
                break
            }
        }
    }

    const sufficient = totalRemoved >= charsToReduce

    return {
        success: truncatedCount > 0,
        sufficient,
        truncatedCount,
        totalBytesRemoved: totalRemoved,
        targetBytesToRemove: charsToReduce,
        truncatedTools,
    }
}
