import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { buildStatsReport } from "../commands/stats"

export type TuiApi = Parameters<NonNullable<TuiPluginModule["tui"]>>[0]
// Colors are optional on purpose: the theme bridge (lib/v2/theme.ts) degrades any
// missing host-theme field to `undefined` instead of crashing the host TUI, and
// @opentui color props treat `undefined` as "unset".
export type Theme = Partial<
    Pick<
        TuiApi["theme"]["current"],
        | "primary"
        | "accent"
        | "text"
        | "textMuted"
        | "background"
        | "backgroundElement"
        | "borderSubtle"
        | "selectedListItemText"
        | "success"
        | "warning"
        | "error"
    >
>
export type ThemeColor = keyof Theme
export type ViewApi = {
    theme: { readonly current: Theme }
    renderer: Pick<TuiApi["renderer"], "height" | "on" | "off">
    ui: { dialog: { clear(): void } }
}
export type StatsReport = Awaited<ReturnType<typeof buildStatsReport>>

export type DcpCommand = {
    title: string
    name: string
    description: string
    slashName: string
    slashAliases?: string[]
    run: () => void | Promise<void>
}
