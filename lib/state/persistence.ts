/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SessionState, SessionStats, Prune } from "./types"
import type { Logger } from "../logger";

export interface PersistedSessionState {
    sessionName?: string;
    prune: Prune
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
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return;
        }

        await ensureStorageDir();

        const state: PersistedSessionState = {
            sessionName: sessionName,
            prune: sessionState.prune,
            stats: sessionState.stats,
            lastUpdated: new Date().toISOString(),
        };

        const filePath = getSessionFilePath(sessionState.sessionId);
        const content = JSON.stringify(state, null, 2);
        await fs.writeFile(filePath, content, "utf-8");

        logger.info("Saved session state to disk", {
            sessionId: sessionState.sessionId,
            totalTokensSaved: state.stats.totalPruneTokens
        });
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        });
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId);

        if (!existsSync(filePath)) {
            return null;
        }

        const content = await fs.readFile(filePath, "utf-8");
        const state = JSON.parse(content) as PersistedSessionState;

        if (!state ||
            !state.prune ||
            !Array.isArray(state.prune.toolIds) ||
            !state.stats
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            });
            return null;
        }

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
            totalTokensSaved: state.stats.totalPruneTokens
        });

        return state;
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        });
        return null;
    }
}
