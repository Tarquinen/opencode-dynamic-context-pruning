import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveSurface, resolveViewTheme } from "../lib/v2/theme"

function theme2010() {
    // OpenCode 2.0.10 shape: `surface(name)` dialog surface + `base`-keyed tokens.
    const base = {
        text: {
            base: "t.base",
            muted: "t.muted",
            action: { primary: { base: "a.primary" }, secondary: { base: "a.secondary" } },
            feedback: {
                success: { base: "f.success" },
                warning: { base: "f.warning" },
                error: { base: "f.error" },
            },
        },
        background: { base: "bg.base", raised: { base: "bg.raised.base" } },
        border: { base: "border.base" },
    }
    return {
        ...base,
        surface: (name: string) => {
            if (name !== "dialog") throw new Error(`unknown surface: ${name}`)
            return {
                ...base,
                background: { ...base.background, base: "dialog.bg.base" },
            }
        },
    }
}

function theme2004() {
    // OpenCode 2.0.4 shape: `contextual.overlay` + `default`-keyed tokens.
    const overlay = {
        text: {
            default: "t.default",
            subdued: "t.subdued",
            action: { primary: { default: "a.primary" }, secondary: { default: "a.secondary" } },
            feedback: {
                success: { default: "f.success" },
                warning: { default: "f.warning" },
                error: { default: "f.error" },
            },
        },
        background: { default: "bg.default", surface: { offset: "bg.surface.offset" } },
        border: { default: "border.default" },
    }
    return { contextual: { overlay, elevated: overlay } }
}

describe("resolveSurface", () => {
    it("prefers the v2.0.10 dialog surface", () => {
        const theme = theme2010()
        assert.equal(
            (resolveSurface(theme) as { background: { base: string } }).background.base,
            "dialog.bg.base",
        )
    })

    it("falls back to the 2.0.4 contextual overlay", () => {
        const surface = resolveSurface(theme2004())
        assert.equal((surface as { text: { default: string } }).text.default, "t.default")
    })

    it("falls back to the base theme and tolerates garbage", () => {
        const base = { text: { base: "x" } }
        assert.equal(resolveSurface(base), base)
        assert.equal(resolveSurface(undefined), undefined)
        assert.equal(resolveSurface(null), undefined)
        assert.equal(resolveSurface(42), undefined)
    })
})

describe("resolveViewTheme", () => {
    it("maps the 2.0.10 theme through the dialog surface", () => {
        const current = resolveViewTheme(() => theme2010()).current
        assert.equal(current.primary, "a.primary")
        assert.equal(current.accent, "a.secondary")
        assert.equal(current.text, "t.base")
        assert.equal(current.textMuted, "t.muted")
        assert.equal(current.background, "dialog.bg.base")
        assert.equal(current.backgroundElement, "bg.raised.base")
        assert.equal(current.borderSubtle, "border.base")
        assert.equal(current.selectedListItemText, "dialog.bg.base")
        assert.equal(current.success, "f.success")
        assert.equal(current.warning, "f.warning")
        assert.equal(current.error, "f.error")
    })

    it("maps the legacy 2.0.4 theme through contextual.overlay", () => {
        const current = resolveViewTheme(() => theme2004()).current
        assert.equal(current.primary, "a.primary")
        assert.equal(current.accent, "a.secondary")
        assert.equal(current.text, "t.default")
        assert.equal(current.textMuted, "t.subdued")
        assert.equal(current.background, "bg.default")
        assert.equal(current.backgroundElement, "bg.surface.offset")
        assert.equal(current.borderSubtle, "border.default")
        assert.equal(current.selectedListItemText, "bg.default")
        assert.equal(current.success, "f.success")
        assert.equal(current.warning, "f.warning")
        assert.equal(current.error, "f.error")
    })

    it("never throws and degrades to unset colors for theme-less hosts", () => {
        for (const theme of [undefined, null, 42, "x", {}, { surface: "not-a-function" }]) {
            const current = resolveViewTheme(() => theme).current
            for (const key of Object.keys(current)) {
                assert.equal(current[key as keyof typeof current], undefined, `key: ${key}`)
            }
        }
    })

    it("survives a throwing surface() and partial themes", () => {
        const throwing = {
            surface: () => {
                throw new Error("host drift")
            },
        }
        assert.doesNotThrow(() => resolveViewTheme(() => throwing).current)
        assert.equal(resolveViewTheme(() => throwing).current.background, undefined)

        const partial = { surface: () => ({ text: { base: "only-text" } }) }
        const current = resolveViewTheme(() => partial).current
        assert.equal(current.text, "only-text")
        assert.equal(current.primary, undefined)
    })

    it("stays live: reads the theme on every access", () => {
        let theme: unknown = theme2004()
        const view = resolveViewTheme(() => theme)
        assert.equal(view.current.text, "t.default")
        theme = theme2010()
        assert.equal(view.current.text, "t.base")
        theme = undefined
        assert.equal(view.current.text, undefined)
    })
})
