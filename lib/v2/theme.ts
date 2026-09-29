import type { Theme } from "../tui/types"

/**
 * Defensive bridge between the host TUI theme and the plugin's ViewApi.
 *
 * OpenCode 2.0.10 reshaped the resolved theme (`@opencode/theme`): the old
 * `theme.contextual.overlay` surface became `theme.surface("dialog")` and the
 * token paths were renamed — `text.default` → `text.base`, `text.subdued` →
 * `text.muted`, `background.default` → `background.base`,
 * `background.surface.offset` → `background.raised.base`, and the action /
 * feedback state keys `default` → `base`. Older hosts still expose the 2.0.4
 * shape, and a future host may reshape it again or hand us nothing at all.
 *
 * This layer is cosmetic: every access is defensive and a missing theme or
 * nested field degrades to `undefined` (which @opentui color props treat as
 * "unset"). It must never throw — a styling gap may not crash the host TUI.
 */

function pickPath(root: unknown, path: string): unknown {
    let node: unknown = root
    for (const key of path.split(".")) {
        if (!node || typeof node !== "object") return undefined
        node = (node as Record<string, unknown>)[key]
    }
    return node
}

function firstDefined(root: unknown, ...paths: string[]): Theme[keyof Theme] {
    for (const path of paths) {
        const value = pickPath(root, path)
        if (value !== undefined && value !== null) return value as Theme[keyof Theme]
    }
    return undefined
}

/**
 * Picks the surface the dialogs render on: the host's dialog surface when the
 * host exposes `surface(name)` (2.0.10+), the legacy `contextual.overlay`
 * when present (2.0.4-era), else the base theme itself.
 */
export function resolveSurface(theme: unknown): unknown {
    if (!theme || typeof theme !== "object") return undefined
    const surface = pickPath(theme, "surface")
    if (typeof surface === "function") {
        try {
            const dialog = (surface as (name: string) => unknown)("dialog")
            if (dialog && typeof dialog === "object") return dialog
        } catch {
            // Host drift or a throwing resolver — fall back to the base theme.
        }
    }
    const overlay = pickPath(theme, "contextual.overlay")
    if (overlay && typeof overlay === "object") return overlay
    return theme
}

/**
 * Builds the ViewApi theme from a live host-theme accessor. `current` stays a
 * getter so a host that swaps or mutates the theme keeps flowing through.
 */
export function resolveViewTheme(getTheme: () => unknown): { readonly current: Theme } {
    return {
        get current() {
            const surface = resolveSurface(getTheme())
            return {
                primary: firstDefined(
                    surface,
                    "text.action.primary.base",
                    "text.action.primary.default",
                ),
                accent: firstDefined(
                    surface,
                    "text.action.secondary.base",
                    "text.action.secondary.default",
                ),
                text: firstDefined(surface, "text.base", "text.default"),
                textMuted: firstDefined(surface, "text.muted", "text.subdued"),
                background: firstDefined(surface, "background.base", "background.default"),
                backgroundElement: firstDefined(
                    surface,
                    "background.raised.base",
                    "background.surface.offset",
                ),
                borderSubtle: firstDefined(surface, "border.base", "border.default"),
                selectedListItemText: firstDefined(
                    surface,
                    "background.base",
                    "background.default",
                ),
                success: firstDefined(
                    surface,
                    "text.feedback.success.base",
                    "text.feedback.success.default",
                ),
                warning: firstDefined(
                    surface,
                    "text.feedback.warning.base",
                    "text.feedback.warning.default",
                ),
                error: firstDefined(
                    surface,
                    "text.feedback.error.base",
                    "text.feedback.error.default",
                ),
            }
        },
    }
}
