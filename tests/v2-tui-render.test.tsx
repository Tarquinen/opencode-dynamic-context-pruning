/**
 * TUI render regression test (bun-only: @opentui's renderables need its FFI
 * backend, which node cannot load — run via `npm run test:tui`).
 *
 * The host TUI crashed when the DCP panel opened because the theme bridge read
 * `ctx.theme.contextual.overlay`, a field that no longer exists in
 * OpenCode 2.0.10. These tests render every dialog through the real opentui
 * renderer with a theme-less context and both known host theme shapes and
 * assert nothing throws.
 */
/** @jsxImportSource @opentui/solid */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseColor } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../lib/tui/dialogs"
import type { ViewApi } from "../lib/tui/types"
import { resolveViewTheme } from "../lib/v2/theme"

const breakdown = {
    total: 1000,
    system: 400,
    user: 200,
    assistant: 200,
    tools: 200,
    toolsInContextCount: 3,
    prunedToolCount: 2,
    prunedMessageCount: 1,
    prunedTokens: 500,
} as unknown as Parameters<typeof ContextDialog>[0]["breakdown"]

const report = {
    sessionTokens: 1000,
    sessionSummaryTokens: 250,
    sessionDurationMs: 12,
    sessionTools: 2,
    sessionMessages: 1,
    allTime: { totalTokens: 9000, totalTools: 10, totalMessages: 20, sessionCount: 7 },
} as unknown as Parameters<typeof StatsDialog>[0]["report"]

function apiFor(theme: () => unknown): ViewApi {
    return {
        renderer: {
            height: 40,
            on: () => () => {},
            off: () => {},
        },
        theme: resolveViewTheme(theme),
        ui: { dialog: { clear() {} } },
    }
}

async function rendersWithoutThrow(theme: () => unknown, label: string) {
    const api = apiFor(theme)
    const dialogs = [
        () => <StatusDialog api={api} title="DCP" eyebrow="DCP" message="hello" />,
        () => <ContextDialog api={api} breakdown={breakdown} onBack={() => {}} />,
        () => <StatsDialog api={api} report={report} onBack={() => {}} />,
        () => (
            <PanelDialog
                api={api}
                manualMode={false}
                canCompress={true}
                onContext={() => {}}
                onStats={() => {}}
                onManual={() => {}}
            />
        ),
    ]
    for (const [index, dialog] of dialogs.entries()) {
        const setup = await testRender(dialog as never)
        try {
            assert.ok(setup.renderer, `${label}: dialog ${index} rendered without a renderer`)
        } finally {
            await setup.renderer.destroy()
        }
    }
}

describe("dialogs render without a host theme", () => {
    it("renders every dialog with a theme-less context without throwing", async () => {
        await rendersWithoutThrow(() => undefined, "theme-less")
    })

    it("renders every dialog with the OpenCode 2.0.10 theme shape", async () => {
        const c = parseColor
        const base = {
            text: {
                base: c("#ffffff"),
                muted: c("#999999"),
                action: { primary: { base: c("#3399ff") }, secondary: { base: "#9933ff" } },
                feedback: {
                    success: { base: c("#33cc66") },
                    warning: { base: c("#ffb333") },
                    error: { base: c("#ff4d4d") },
                },
            },
            background: { base: c("#1a1a1a"), raised: { base: c("#262626") } },
            border: { base: c("#4d4d4d") },
        }
        const theme = {
            ...base,
            surface: (name: string) => {
                if (name !== "dialog") throw new Error(`unknown surface: ${name}`)
                return base
            },
        }
        await rendersWithoutThrow(() => theme, "2.0.10-shaped")
    })
})
