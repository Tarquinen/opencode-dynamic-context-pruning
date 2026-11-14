import { readFile, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginInput } from "@opencode-ai/plugin"

type PackageJson = {
    name?: string
    version?: string
    dependencies?: Record<string, string>
}

type UpdateResult =
    | { updated: true; name: string; current: string; latest: string }
    | { updated: false; error: "remove_failed"; name: string; current: string; latest: string }
    | { updated: false }

const PACKAGE_NAME = "@mbarnett/opencode-dcp"

export function startAutoUpdate(ctx: PluginInput, enabled: boolean): void {
    if (!enabled) return

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    void checkAutoUpdate(controller.signal)
        .then((result) => {
            if (!result.updated) return
            setTimeout(() => {
                ctx.client.tui.showToast({
                    body: {
                        title: "DCP update ready",
                        message: `Updated ${result.name} from ${result.current} to ${result.latest}. Restart OpenCode to finish.`,
                        variant: "info",
                        duration: 7000,
                    },
                })
            }, 5000)
        })
        .catch(() => {})
        .finally(() => clearTimeout(timeout))
}

export async function checkAutoUpdate(signal: AbortSignal): Promise<UpdateResult> {
    const packageDir = await findPackageDir(PACKAGE_NAME)
    if (!packageDir) return { updated: false }

    const pkg = await readPackageJson(join(packageDir, "package.json"))
    if (!pkg?.name || !pkg.version) return { updated: false }

    const latest = await fetchLatestVersion(pkg.name, signal)
    if (!latest || !isVersionNewer(latest, pkg.version)) return { updated: false }

    const removeDir = await updateRemoveDir(packageDir, pkg.name)
    if (!removeDir) return { updated: false }

    try {
        await rm(removeDir, { recursive: true, force: true })
    } catch {
        return {
            updated: false,
            error: "remove_failed",
            name: pkg.name,
            current: pkg.version,
            latest,
        }
    }

    return { updated: true, name: pkg.name, current: pkg.version, latest }
}

async function findPackageDir(name: string) {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (;;) {
        const pkg = await readPackageJson(join(dir, "package.json"))
        if (pkg?.name === name) return dir

        const parent = dirname(dir)
        if (parent === dir) return undefined
        dir = parent
    }
}

export async function updateRemoveDir(packageDir: string, name: string) {
    const packageParent = dirname(packageDir)
    const nodeModulesDir = basename(packageParent).startsWith("@")
        ? dirname(packageParent)
        : packageParent
    if (basename(nodeModulesDir) !== "node_modules") return undefined

    const wrapperDir = dirname(nodeModulesDir)
    const wrapperPkg = await readPackageJson(join(wrapperDir, "package.json"))
    const spec = wrapperSpec(wrapperDir, name) ?? wrapperPkg?.dependencies?.[name]
    if (!spec || !isAutoUpdatableSpec(spec)) return undefined

    return wrapperDir
}

function wrapperSpec(wrapperDir: string, name: string) {
    if (name.startsWith("@")) {
        const [scope, pkg] = name.split("/")
        if (!scope || !pkg || basename(dirname(wrapperDir)) !== scope) return undefined
        const prefix = `${pkg}@`
        const base = basename(wrapperDir)
        return base.startsWith(prefix) ? base.slice(prefix.length) : undefined
    }

    const prefix = `${name}@`
    const base = basename(wrapperDir)
    return base.startsWith(prefix) ? base.slice(prefix.length) : undefined
}

export function isAutoUpdatableSpec(spec: string) {
    const value = spec.trim()
    if (!value) return false
    if (value === "latest" || value === "*") return true
    if (/^[~^]/.test(value)) return true
    if (/^(?:>=|>|<=|<)/.test(value)) return true
    if (/\s+(?:\|\||-|[<>=])\s+/.test(value)) return true
    return false
}

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
    try {
        const data = JSON.parse(await readFile(path, "utf-8"))
        return data && typeof data === "object" ? (data as PackageJson) : undefined
    } catch {
        return undefined
    }
}

async function fetchLatestVersion(name: string, signal: AbortSignal) {
    try {
        const response = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
            {
                signal,
            },
        )
        if (!response.ok) return undefined
        const data: unknown = await response.json()
        if (!data || typeof data !== "object") return undefined
        const version = (data as { version?: unknown }).version
        return typeof version === "string" ? version : undefined
    } catch {
        return undefined
    }
}

export function isVersionNewer(latest: string, current: string) {
    const next = parseVersion(latest)
    const prev = parseVersion(current)
    if (!next || !prev) return false

    for (let i = 0; i < 3; i++) {
        if (next.parts[i] !== prev.parts[i]) return next.parts[i] > prev.parts[i]
    }

    if (!next.pre.length && prev.pre.length) return true
    if (next.pre.length && !prev.pre.length) return false

    for (let i = 0; i < Math.max(next.pre.length, prev.pre.length); i++) {
        const a = next.pre[i]
        const b = prev.pre[i]
        if (a === undefined) return false
        if (b === undefined) return true
        if (a === b) continue

        const aNumber = /^\d+$/.test(a) ? Number(a) : undefined
        const bNumber = /^\d+$/.test(b) ? Number(b) : undefined
        if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber
        if (aNumber !== undefined) return false
        if (bNumber !== undefined) return true
        return a > b
    }

    return false
}

function parseVersion(version: string) {
    const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/)
    if (!match) return undefined
    return {
        parts: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4]?.split(".") ?? [],
    }
}
