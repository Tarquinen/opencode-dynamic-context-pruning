import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser/lib/esm/main.js"
import type { PluginInput } from "@opencode-ai/plugin"

type ConfigContext = Pick<PluginInput, "directory"> & {
    client: {
        tui: {
            showToast(input: {
                body: { title: string; message: string; variant: "warning"; duration: number }
            }): unknown
        }
    }
}

type Permission = "ask" | "allow" | "deny"
type CompressMode = "range" | "message"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface CompressConfig {
    mode: CompressMode
    permission: Permission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: number | `${number}%`
    minContextLimit: number | `${number}%`
    modelMaxLimits?: Record<string, number | `${number}%`>
    modelMinLimits?: Record<string, number | `${number}%`>
    nudgeFrequency: number
    iterationNudgeThreshold: number
    nudgeForce: "strong" | "soft"
    protectedTools: string[]
    protectTags: boolean
    protectUserMessages: boolean
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ManualModeConfig {
    enabled: boolean
    automaticStrategies: boolean
}

export interface PurgeErrors {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface ExperimentalConfig {
    allowSubAgents: boolean
    customPrompts: boolean
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    pruneNotificationType: "chat" | "toast"
    commands: Commands
    manualMode: ManualModeConfig
    turnProtection: TurnProtection
    experimental: ExperimentalConfig
    protectedFilePatterns: string[]
    compress: CompressConfig
    strategies: {
        deduplication: Deduplication
        purgeErrors: PurgeErrors
    }
}

type CompressOverride = Partial<CompressConfig>

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
]

const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"]

/**
 * Keys that are valid but absent from `defaultConfig`: the `$schema` marker we
 * write into generated files, and the two optional per-model limit maps.
 */
const OPTIONAL_CONFIG_KEYS = ["$schema", "compress.modelMaxLimits", "compress.modelMinLimits"]

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        // model*Limits are dynamic maps keyed by providerID/modelID; do not recurse into arbitrary IDs.
        if (fullKey === "compress.modelMaxLimits" || fullKey === "compress.modelMinLimits") {
            continue
        }

        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const known = new Set([...getConfigKeyPaths(defaultConfig), ...OPTIONAL_CONFIG_KEYS])
    return getConfigKeyPaths(userConfig).filter((key) => !known.has(key))
}

interface ValidationError {
    key: string
    expected: string
    actual: string
}

/**
 * A rule reports `null` for a valid value, a bare string for the rule's fixed
 * `expected` label, or an explicit `{ expected, actual }` pair for the handful of
 * checks whose message varies with the offending value.
 */
type Violation = string | { expected: string; actual: string }

interface Rule {
    expected: string
    check: (value: unknown) => Violation | null
}

const booleanRule: Rule = {
    expected: "boolean",
    check: (value) => (typeof value === "boolean" ? null : typeof value),
}

const objectRule = (skipFalsy = false): Rule => ({
    expected: "object",
    check: (value) =>
        skipFalsy && !value
            ? null
            : typeof value === "object" && value !== null && !Array.isArray(value)
              ? null
              : typeof value,
})

const toolListRule: Rule = {
    expected: "string[]",
    check: (value) => (Array.isArray(value) ? null : typeof value),
}

const patternListRule: Rule = {
    expected: "string[]",
    check: (value) =>
        Array.isArray(value)
            ? value.every((entry) => typeof entry === "string")
                ? null
                : "non-string entries"
            : typeof value,
}

const enumerationRule = (...allowed: string[]): Rule => ({
    expected: allowed.map((value) => `"${value}"`).join(" | "),
    check: (value) => (allowed.includes(value as string) ? null : JSON.stringify(value)),
})

/** `min` adds the "below the usable floor" warning the value gets clamped away from. */
const numberRule = (min?: { label: string; suffix: string }): Rule => ({
    expected: "number",
    check: (value) =>
        typeof value !== "number"
            ? typeof value
            : min && value < 1
              ? { expected: min.label, actual: `${value}${min.suffix}` }
              : null,
})

const limitRule: Rule = {
    expected: 'number | "${number}%"',
    check: (value) =>
        typeof value === "number" || (typeof value === "string" && value.endsWith("%"))
            ? null
            : JSON.stringify(value),
}

const modelLimitMapRule: Rule = {
    expected: "Record<string, number | ${number}%>",
    check: (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value) ? null : typeof value,
}

const CLAMPED_POSITIVE = { label: "positive number (>= 1)", suffix: " (will be clamped to 1)" }

/**
 * Every accepted key with its type check, keyed by the same dotted paths
 * `getInvalidConfigKeys` uses. `dcp.schema.json` carries the same shape for
 * editors; this table exists to warn at load time.
 */
const CONFIG_RULES: Record<string, Rule> = {
    enabled: booleanRule,
    autoUpdate: booleanRule,
    debug: booleanRule,
    pruneNotification: enumerationRule("off", "minimal", "detailed"),
    pruneNotificationType: enumerationRule("chat", "toast"),
    protectedFilePatterns: patternListRule,
    turnProtection: objectRule(true),
    "turnProtection.enabled": booleanRule,
    "turnProtection.turns": numberRule({ label: "positive number (>= 1)", suffix: "" }),
    experimental: objectRule(),
    "experimental.allowSubAgents": booleanRule,
    "experimental.customPrompts": booleanRule,
    commands: objectRule(),
    "commands.enabled": booleanRule,
    "commands.protectedTools": toolListRule,
    manualMode: objectRule(),
    "manualMode.enabled": booleanRule,
    "manualMode.automaticStrategies": booleanRule,
    compress: objectRule(),
    "compress.mode": enumerationRule("range", "message"),
    "compress.summaryBuffer": booleanRule,
    "compress.nudgeFrequency": numberRule(CLAMPED_POSITIVE),
    "compress.iterationNudgeThreshold": numberRule(CLAMPED_POSITIVE),
    "compress.nudgeForce": enumerationRule("strong", "soft"),
    "compress.protectedTools": toolListRule,
    "compress.protectTags": booleanRule,
    "compress.protectUserMessages": booleanRule,
    "compress.maxContextLimit": limitRule,
    "compress.minContextLimit": limitRule,
    "compress.modelMaxLimits": modelLimitMapRule,
    "compress.modelMinLimits": modelLimitMapRule,
    "compress.permission": enumerationRule("ask", "allow", "deny"),
    "compress.showCompression": booleanRule,
    "strategies.deduplication.enabled": booleanRule,
    "strategies.deduplication.protectedTools": toolListRule,
    "strategies.purgeErrors.enabled": booleanRule,
    "strategies.purgeErrors.turns": numberRule(CLAMPED_POSITIVE),
    "strategies.purgeErrors.protectedTools": toolListRule,
}

function readConfigPath(config: Record<string, any>, path: string): unknown {
    let value: unknown = config
    for (const segment of path.split(".")) {
        if (typeof value !== "object" || value === null) return undefined
        value = (value as Record<string, unknown>)[segment]
    }
    return value
}

/** Per-model entries of the two dynamic limit maps, keyed `compress.modelMaxLimits.<id>`. */
function validateModelLimitEntries(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []
    const compress = readConfigPath(config, "compress")
    if (typeof compress !== "object" || compress === null || Array.isArray(compress)) return errors

    for (const field of ["modelMaxLimits", "modelMinLimits"] as const) {
        const limits = (compress as Record<string, unknown>)[field]
        if (typeof limits !== "object" || limits === null || Array.isArray(limits)) continue

        for (const [modelKey, limit] of Object.entries(limits as Record<string, unknown>)) {
            const isPercent = typeof limit === "string" && /^\d+(?:\.\d+)?%$/.test(limit)
            if (typeof limit !== "number" && !isPercent) {
                errors.push({
                    key: `compress.${field}.${modelKey}`,
                    expected: 'number | "${number}%"',
                    actual: JSON.stringify(limit),
                })
            }
        }
    }

    return errors
}

export function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    for (const [key, rule] of Object.entries(CONFIG_RULES)) {
        const value = readConfigPath(config, key)
        if (value === undefined) continue

        const violation = rule.check(value)
        if (!violation) continue

        errors.push(
            typeof violation === "string"
                ? { key, expected: rule.expected, actual: violation }
                : { key, expected: violation.expected, actual: violation.actual },
        )
    }

    return errors.concat(validateModelLimitEntries(config))
}

function showConfigWarnings(
    ctx: ConfigContext,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `DCP: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    autoUpdate: true,
    debug: false,
    pruneNotification: "detailed",
    pruneNotificationType: "chat",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    experimental: {
        allowSubAgents: false,
        customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        showCompression: false,
        summaryBuffer: true,
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
        protectTags: false,
        protectUserMessages: false,
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "dcp.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "dcp.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

/** Prefers `dcp.jsonc`, falls back to `dcp.json`; null when the directory has neither. */
function configInDir(dir: string): string | null {
    for (const name of ["dcp.jsonc", "dcp.json"]) {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return candidate
    }
    return null
}

function getConfigPaths(ctx?: ConfigContext): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    const opencodeDir = ctx?.directory ? findOpencodeDir(ctx.directory) : null

    return {
        global: configInDir(GLOBAL_CONFIG_DIR),
        configDir: opencodeConfigDir ? configInDir(opencodeConfigDir) : null,
        project: opencodeDir ? configInDir(opencodeDir) : null,
    }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

/**
 * Arrays a user extends rather than replaces: an override appends to the default
 * list (deduped) instead of swapping it out.
 */
const UNION_ARRAY_KEYS = new Set([
    "commands.protectedTools",
    "compress.protectedTools",
    "protectedFilePatterns",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors.protectedTools",
])

/**
 * Objects replaced wholesale rather than merged key-by-key, so a project config
 * cannot leave a single stale model behind in a base config's limits map.
 */
const REPLACE_WHOLE_KEYS = new Set(["compress.modelMaxLimits", "compress.modelMinLimits"])

const isPlainObject = (value: unknown): value is Record<string, any> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Merges one config layer over the accumulated defaults: absent keys keep their
 * default, scalar keys are replaced, `protectedTools`/pattern lists are unioned,
 * and the two per-model limit maps are swapped whole.
 */
function mergeConfigLayer<T extends Record<string, any>>(base: T, override: any, prefix = ""): T {
    const merged: Record<string, any> = { ...base }

    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue

        const path = prefix ? `${prefix}.${key}` : key
        const current = merged[key]

        if (UNION_ARRAY_KEYS.has(path)) {
            merged[key] = [...new Set([...((current as string[]) ?? []), ...(value as string[])])]
        } else if (
            !REPLACE_WHOLE_KEYS.has(path) &&
            isPlainObject(value) &&
            isPlainObject(current)
        ) {
            merged[key] = mergeConfigLayer(current, value, path)
        } else {
            merged[key] = value
        }
    }

    return merged as T
}

function scheduleParseWarning(ctx: ConfigContext, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title,
                    message,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: ConfigContext): PluginConfig {
    let config = structuredClone(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global) {
        createDefaultConfig()
    }

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) {
            continue
        }

        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `DCP: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }

        if (!result.data) {
            continue
        }

        showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeConfigLayer(config, result.data)
    }

    return config
}
