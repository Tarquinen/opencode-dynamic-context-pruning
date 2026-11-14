import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { buildStatsReport } from "../commands/stats"

export type TuiApi = Parameters<NonNullable<TuiPluginModule["tui"]>>[0]
export type Theme = Pick<
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
export type ThemeColor = keyof Theme
export type ViewApi = {
    centeredDialog?: boolean
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
