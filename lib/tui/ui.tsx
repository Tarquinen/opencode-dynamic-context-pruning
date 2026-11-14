/** @jsxImportSource @opentui/solid */

import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "solid-js"
import { pct } from "./format"
import type { Theme, ThemeColor, ViewApi } from "./types"

// header (1-2) + divider (1) + footer (2) + gaps (3) + bottom padding (1)
const FRAME_OVERHEAD = 9

export function DcpFrame(props: {
    api: ViewApi
    title?: string
    eyebrow: string
    children: JSX.Element
    onBack?: () => void
}) {
    const theme = props.api.theme.current
    let body: ScrollBoxRenderable | undefined
    let inner: BoxRenderable | undefined
    function available() {
        const height = props.api.renderer.height
        const reserved = props.api.centeredDialog ? 4 : Math.floor(height / 4) + 2
        return Math.max(1, height - reserved - FRAME_OVERHEAD)
    }
    function resize() {
        const extra = props.api.centeredDialog ? 2 : 0
        if (body)
            body.height = Math.min(inner?.height ? inner.height + extra : available(), available())
    }
    return (
        <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
                <box flexDirection="column">
                    <text fg={theme.primary}>
                        <b>{props.eyebrow}</b>
                    </text>
                    {props.title ? (
                        <text fg={theme.text}>
                            <b>{props.title}</b>
                        </text>
                    ) : null}
                </box>
                <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
                    esc
                </text>
            </box>
            <box height={1} border={["bottom"]} borderColor={theme.borderSubtle} />
            <scrollbox
                height={available()}
                scrollY
                ref={(r: ScrollBoxRenderable) => {
                    body = r
                    // Use the host renderer rather than a separate OpenTUI/Solid context.
                    props.api.renderer.on("resize", resize)
                    r.once("destroyed", () => props.api.renderer.off("resize", resize))
                    resize()
                }}
            >
                <box ref={(r: BoxRenderable) => (inner = r)} onSizeChange={resize}>
                    {props.children}
                </box>
            </scrollbox>
            <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
                {props.onBack ? (
                    <FooterButton
                        theme={theme}
                        label="back"
                        variant="muted"
                        onClick={props.onBack}
                    />
                ) : (
                    <box />
                )}
                <FooterButton
                    theme={theme}
                    label="close"
                    variant="primary"
                    onClick={() => props.api.ui.dialog.clear()}
                />
            </box>
        </box>
    )
}

function FooterButton(props: {
    theme: Theme
    label: string
    variant: "muted" | "primary"
    onClick: () => void
}) {
    const primary = props.variant === "primary"
    return (
        <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={primary ? props.theme.primary : props.theme.backgroundElement}
            onMouseUp={props.onClick}
        >
            <text fg={primary ? props.theme.selectedListItemText : props.theme.text}>
                {props.label}
            </text>
        </box>
    )
}

export function Card(props: { theme: Theme; title: string; children: JSX.Element }) {
    const accent = props.theme.primary
    return (
        <box
            flexDirection="column"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={props.theme.backgroundElement}
            border={["left"]}
            borderColor={accent}
            gap={1}
        >
            <text fg={accent}>
                <b>{props.title}</b>
            </text>
            {props.children}
        </box>
    )
}

export function Metric(props: { theme: Theme; label: string; value: string; hint?: string }) {
    return (
        <box flexDirection="row" gap={2}>
            <box width={24}>
                <text fg={props.theme.textMuted}>{props.label}</text>
            </box>
            <box flexDirection="row" gap={1} flexGrow={1}>
                <text fg={props.theme.text}>
                    <b>{props.value}</b>
                </text>
                {props.hint ? <text fg={props.theme.textMuted}>{props.hint}</text> : null}
            </box>
        </box>
    )
}

export function Progress(props: {
    theme: Theme
    label: string
    value: number
    total: number
    color: ThemeColor
    detail: string
}) {
    const width = 32
    const filled =
        props.total > 0 ? Math.max(0, Math.round((props.value / props.total) * width)) : 0
    const empty = Math.max(0, width - filled)
    return (
        <box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={2}>
                <box width={20}>
                    <text fg={props.theme.text}>{props.label}</text>
                </box>
                <box flexDirection="row" gap={1} flexGrow={1}>
                    <text fg={props.theme.text}>
                        <b>{pct(props.value, props.total)}</b>
                    </text>
                    <text fg={props.theme.textMuted}>{props.detail}</text>
                </box>
            </box>
            <box flexDirection="row">
                <text fg={props.theme[props.color]}>{"█".repeat(filled)}</text>
                <text fg={props.theme.borderSubtle}>{"░".repeat(empty)}</text>
            </box>
        </box>
    )
}

export function PromptRow(props: {
    theme: Theme
    command: string
    description: string
    accent?: ThemeColor
}) {
    const accent = props.theme[props.accent ?? "accent"]
    return (
        <box flexDirection="row" gap={2}>
            <box width={22}>
                <text fg={accent}>
                    <b>{props.command}</b>
                </text>
            </box>
            <box flexGrow={1}>
                <text fg={props.theme.text}>{props.description}</text>
            </box>
        </box>
    )
}

export function StatusPill(props: {
    theme: Theme
    label: string
    value: string
    accent: ThemeColor
}) {
    const accent = props.theme[props.accent]
    return (
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <box width={22}>
                <text fg={props.theme.primary}>
                    <b>{props.label}</b>
                </text>
            </box>
            <text fg={accent}>
                <b>{props.value}</b>
            </text>
        </box>
    )
}

export function ActionRow(props: {
    theme: Theme
    title: string
    detail: string
    onClick: () => void
}) {
    const accent = props.theme.primary
    return (
        <box
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={props.onClick}
        >
            <box flexDirection="row" gap={2}>
                <box width={12}>
                    <text fg={accent}>
                        <b>{props.title}</b>
                    </text>
                </box>
                <text fg={props.theme.text}>{props.detail}</text>
            </box>
            <box paddingLeft={2} paddingRight={2} backgroundColor={accent}>
                <text fg={props.theme.selectedListItemText}>open</text>
            </box>
        </box>
    )
}
