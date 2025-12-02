/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SessionStats } from "../core/janitor";
import type { Logger } from "../logger";

export interface PersistedSessionState {
    sessionName?: string;
    prunedIds: string[];
    stats: SessionStats;
    lastUpdated: string;
}

const STORAGE_DIR = join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "storage",
    "plugin",
    "dcp"
);

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true });
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json`);
}

export async function saveSessionState(
    sessionId: string,
    prunedIds: Set<string>,
    stats: SessionStats,
    logger?: Logger,
    sessionName?: string
): Promise<void> {
    try {
        await ensureStorageDir();

        const state: PersistedSessionState = {
            ...(sessionName && { sessionName }),
            prunedIds: Array.from(prunedIds),
            stats,
            lastUpdated: new Date().toISOString(),
        };

        const filePath = getSessionFilePath(sessionId);
        const content = JSON.stringify(state, null, 2);
        await fs.writeFile(filePath, content, "utf-8");

        logger?.info("persist", "Saved session state to disk", {
            sessionId: sessionId.slice(0, 8),
            prunedIds: prunedIds.size,
            totalTokensSaved: stats.totalTokensSaved,
        });
    } catch (error: any) {
        logger?.error("persist", "Failed to save session state", {
            sessionId: sessionId.slice(0, 8),
            error: error?.message,
        });
    }
}

export async function loadSessionState(
    sessionId: string,
    logger?: Logger
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId);

        if (!existsSync(filePath)) {
            return null;
        }

        const content = await fs.readFile(filePath, "utf-8");
        const state = JSON.parse(content) as PersistedSessionState;

        if (!state || !Array.isArray(state.prunedIds) || !state.stats) {
            logger?.warn("persist", "Invalid session state file, ignoring", {
                sessionId: sessionId.slice(0, 8),
            });
            return null;
        }

        logger?.info("persist", "Loaded session state from disk", {
            sessionId: sessionId.slice(0, 8),
            prunedIds: state.prunedIds.length,
            totalTokensSaved: state.stats.totalTokensSaved,
        });

        return state;
    } catch (error: any) {
        logger?.warn("persist", "Failed to load session state", {
            sessionId: sessionId.slice(0, 8),
            error: error?.message,
        });
        return null;
    }
}
