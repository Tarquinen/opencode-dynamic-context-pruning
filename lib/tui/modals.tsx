/** @jsxImportSource @opentui/solid */

import { buildStatsReport } from "../commands/stats"
import { analyzeContextTokens } from "../commands/context"
import { compressPermission } from "../compress-permission"
import type { PluginConfig } from "../config"
import { saveManualModeSetting } from "../state/persistence"
import { loadSessionData, logger } from "./data"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "./dialogs"
import type { TuiApi } from "./types"

export function showDialog(api: TuiApi, render: () => any) {
    api.ui.dialog.setSize("xlarge")
    api.ui.dialog.replace(render)
}

export function showStatusDialog(api: TuiApi, title: string, eyebrow: string, message: string) {
    showDialog(api, () => (
        <StatusDialog api={api} title={title} eyebrow={eyebrow} message={message} />
    ))
}

export function showError(api: TuiApi, title: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    showStatusDialog(api, title, "DCP Error", message || "Command failed.")
}

export function openContextModal(api: TuiApi, config: PluginConfig) {
    runModal(api, "Context", async () => {
        const data = await loadSessionData(api, config)
        if (!data) {
            showStatusDialog(api, "Context", "No session", "Open a session first.")
            return
        }
        const breakdown = await analyzeContextTokens(data.state, data.messages)
        showDialog(api, () => (
            <ContextDialog
                api={api}
                breakdown={breakdown}
                onBack={() => openPanelModal(api, config)}
            />
        ))
    })
}

export function openStatsModal(api: TuiApi, config: PluginConfig) {
    runModal(api, "Stats", async () => {
        const data = await loadSessionData(api, config)
        if (!data) {
            showStatusDialog(api, "Stats", "No session", "Open a session first.")
            return
        }
        const report = await buildStatsReport(data.state, logger)
        showDialog(api, () => (
            <StatsDialog api={api} report={report} onBack={() => openPanelModal(api, config)} />
        ))
    })
}

export function openPanelModal(api: TuiApi, config: PluginConfig) {
    runModal(api, "DCP", async () => {
        const data = await loadSessionData(api, config)
        if (!data) {
            showStatusDialog(api, "DCP", "No session", "Open a session first.")
            return
        }
        showDialog(api, () => (
            <PanelDialog
                api={api}
                manualMode={!!data.state.manualMode}
                canCompress={compressPermission(data.state, config) !== "deny"}
                onContext={() => openContextModal(api, config)}
                onStats={() => openStatsModal(api, config)}
                onManual={(enabled) => setManualMode(api, config, data.state.sessionId, enabled)}
            />
        ))
    })
}

function runModal(api: TuiApi, title: string, task: () => Promise<void>) {
    showStatusDialog(api, title, "DCP", "Loading...")
    void task().catch((error) => showError(api, title, error))
}

async function setManualMode(
    api: TuiApi,
    config: PluginConfig,
    sessionID: string | null | undefined,
    enabled: boolean,
) {
    if (!sessionID) return
    await saveManualModeSetting(sessionID, enabled, logger)
    openPanelModal(api, config)
}
