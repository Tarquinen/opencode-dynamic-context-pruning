/**
 * Tool tracker for tracking tool results and managing nudge frequency.
 */

export interface ToolTracker {
    seenToolResultIds: Set<string>
    toolResultCount: number  // Tools since last prune
    skipNextIdle: boolean
    getToolName?: (callId: string) => string | undefined
}

export function createToolTracker(): ToolTracker {
    return { seenToolResultIds: new Set(), toolResultCount: 0, skipNextIdle: false }
}

export function resetToolTrackerCount(tracker: ToolTracker): void {
    tracker.toolResultCount = 0
}
