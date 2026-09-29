/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import type { ViewApi } from "../tui/types"
import { resolveViewTheme } from "./theme"
import { rpc } from "./rpc"
export async function setup(ctx: Plugin.Context) {
    // Feature-detect the host UI APIs this panel needs. A host without them
    // (or a future shape change) must degrade to headless DCP, never crash.
    if (
        typeof ctx.client?.rpc !== "function" ||
        typeof ctx.ui?.dialog?.show !== "function" ||
        typeof ctx.ui.dialog.set !== "function" ||
        typeof ctx.ui.slot !== "function" ||
        typeof ctx.keymap?.layer !== "function"
    ) {
        console.warn(
            "DCP: TUI panel is unavailable in this host (missing UI APIs); DCP keeps running headless.",
        )
        return
    }
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    if (!(await client.status({}, options())).enabled) return

    // Render server-side DCP reports as transient toasts. Events are
    // ephemeral: nothing stored, nothing in model context.
    if (typeof ctx.data?.on === "function" && typeof ctx.ui?.toast?.show === "function") {
        const TOAST_MAX_LINES = 12
        const truncateToast = (message: string): string => {
            const lines = message.split("\n")
            if (lines.length <= TOAST_MAX_LINES) return message
            const remaining = lines.length - TOAST_MAX_LINES + 1
            return (
                lines.slice(0, TOAST_MAX_LINES - 1).join("\n") + `\n... and ${remaining} more`
            )
        }
        ctx.data.on("rpc.dcp.notify", (event) => {
            const data = (event?.data ?? {}) as {
                title?: string
                message?: string
                variant?: "info" | "success" | "warning" | "error"
                duration?: number
            }
            if (!data.message) return
            ctx.ui.toast.show({
                title: data.title ?? "DCP",
                message: truncateToast(data.message),
                variant: data.variant ?? "info",
                duration: data.duration ?? 5000,
            })
        })
    }

    const api: ViewApi = {
        renderer: ctx.renderer,
        theme: resolveViewTheme(() => ctx.theme),
        ui: { dialog: { clear: () => ctx.ui.dialog.clear() } },
    }
    function show(render: Parameters<typeof ctx.ui.dialog.show>[0]) {
        ctx.ui.dialog.set({ size: "xlarge" })
        ctx.ui.dialog.show(render)
    }
    async function open(page: "panel" | "context" | "stats" = "panel") {
        const route = ctx.ui.router.current()
        if (route.type !== "session") {
            show(() => (
                <StatusDialog
                    api={api}
                    title="DCP"
                    eyebrow="No session"
                    message="Open a session first."
                />
            ))
            return
        }
        const sessionID = route.sessionID
        try {
            const data = await client.snapshot({ sessionID }, options())
            const back = () => {
                void open()
            }
            if (page === "context")
                show(() => <ContextDialog api={api} breakdown={data.context} onBack={back} />)
            else if (page === "stats")
                show(() => <StatsDialog api={api} report={data.stats} onBack={back} />)
            else
                show(() => (
                    <PanelDialog
                        api={api}
                        manualMode={data.manualMode}
                        canCompress={data.canCompress}
                        blockedReason={data.blockedReason}
                        onContext={() => {
                            void open("context")
                        }}
                        onStats={() => {
                            void open("stats")
                        }}
                        onManual={(enabled) => {
                            void client
                                .manual({ sessionID, enabled }, options())
                                .then(back)
                                .catch(error)
                        }}
                    />
                ))
        } catch (cause) {
            error(cause)
        }
    }
    function error(cause: unknown) {
        const message =
            cause instanceof Error
                ? cause.message
                : typeof cause === "object" && cause && "message" in cause
                  ? String(cause.message)
                  : String(cause)
        show(() => <StatusDialog api={api} title="DCP" eyebrow="DCP Error" message={message} />)
    }
    ctx.ui.slot({
        append: "app",
        render() {
            ctx.keymap.layer(() => ({
                mode: "global",
                commands: [
                    {
                        id: "dcp.panel",
                        title: "DCP",
                        description: "Open DCP panel",
                        group: "DCP",
                        palette: true,
                        slash: { name: "dcp", arguments: true },
                        run: async (input) => {
                            if (!input?.trim()) return open()
                            const route = ctx.ui.router.current()
                            if (route.type !== "session") return open()
                            try {
                                await ctx.client.session.command({
                                    sessionID: route.sessionID,
                                    name: "dcp",
                                    text: input,
                                })
                            } catch (cause) {
                                error(cause)
                            }
                        },
                    },
                ],
            }))
            return null
        },
    })
}
