/**
 * Numeric ID mapping system for tool call IDs.
 * 
 * Maps simple incrementing numbers (1, 2, 3...) to actual provider tool call IDs
 * (e.g., "call_abc123xyz..."). This allows the session AI to reference tools by
 * simple numbers when using the prune tool.
 * 
 * Design decisions:
 * - IDs are monotonically increasing and never reused (avoids race conditions)
 * - Mappings are rebuilt from session messages on restore (single source of truth)
 * - Per-session mappings to isolate sessions from each other
 */

export interface IdMapping {
    numericToActual: Map<number, string>  // 1 → "call_abc123xyz..."
    actualToNumeric: Map<string, number>  // "call_abc123xyz..." → 1
    nextId: number
}

/** Per-session ID mappings */
const sessionMappings = new Map<string, IdMapping>()

/**
 * Gets or creates the ID mapping for a session.
 */
function getSessionMapping(sessionId: string): IdMapping {
    let mapping = sessionMappings.get(sessionId)
    if (!mapping) {
        mapping = {
            numericToActual: new Map(),
            actualToNumeric: new Map(),
            nextId: 1
        }
        sessionMappings.set(sessionId, mapping)
    }
    return mapping
}

/**
 * Assigns a numeric ID to a tool call ID if it doesn't already have one.
 * Returns the numeric ID (existing or newly assigned).
 */
export function getOrCreateNumericId(sessionId: string, actualId: string): number {
    const mapping = getSessionMapping(sessionId)

    // Check if already mapped
    const existing = mapping.actualToNumeric.get(actualId)
    if (existing !== undefined) {
        return existing
    }

    // Assign new ID
    const numericId = mapping.nextId++
    mapping.numericToActual.set(numericId, actualId)
    mapping.actualToNumeric.set(actualId, numericId)

    return numericId
}

/**
 * Looks up the actual tool call ID for a numeric ID.
 * Returns undefined if the numeric ID doesn't exist.
 */
export function getActualId(sessionId: string, numericId: number): string | undefined {
    const mapping = sessionMappings.get(sessionId)
    return mapping?.numericToActual.get(numericId)
}

/**
 * Looks up the numeric ID for an actual tool call ID.
 * Returns undefined if not mapped.
 */
export function getNumericId(sessionId: string, actualId: string): number | undefined {
    const mapping = sessionMappings.get(sessionId)
    return mapping?.actualToNumeric.get(actualId)
}

/**
 * Gets all current mappings for a session.
 * Useful for debugging and building the prunable tools list.
 */
export function getAllMappings(sessionId: string): Map<number, string> {
    const mapping = sessionMappings.get(sessionId)
    return mapping?.numericToActual ?? new Map()
}

/**
 * Checks if a session has any ID mappings.
 */
export function hasMapping(sessionId: string): boolean {
    return sessionMappings.has(sessionId)
}

/**
 * Clears all ID mappings for a specific session.
 * Call this when a session ends or when switching to a new session.
 */
export function clearSessionMapping(sessionId: string): void {
    sessionMappings.delete(sessionId)
}

/**
 * Clears all session mappings.
 * Call this when switching sessions to ensure clean state.
 */
export function clearAllMappings(): void {
    sessionMappings.clear()
}

/**
 * Gets the next numeric ID that will be assigned (without assigning it).
 * Useful for knowing the current state.
 */
export function getNextId(sessionId: string): number {
    const mapping = sessionMappings.get(sessionId)
    return mapping?.nextId ?? 1
}
