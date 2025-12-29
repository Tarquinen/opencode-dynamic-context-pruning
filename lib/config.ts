import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface OnIdle {
    enabled: boolean
    model?: string
    showModelErrorToasts?: boolean
    strictModelSelection?: boolean
    protectedTools: string[]
}

export interface DiscardTool {
    enabled: boolean
}

export interface ExtractTool {
    enabled: boolean
    showDistillation: boolean
}

export interface ToolSettings {
    nudgeEnabled: boolean
    nudgeFrequency: number
    protectedTools: string[]
    activationThreshold: number
}

export interface Tools {
    settings: ToolSettings
    discard: DiscardTool
    extract: ExtractTool
}

export interface SupersedeWrites {
    enabled: boolean
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

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    turnProtection: TurnProtection
    tools: Tools
    strategies: {
        deduplication: Deduplication
        supersedeWrites: SupersedeWrites
        purgeErrors: PurgeErrors
        onIdle: OnIdle
    }
}

const DEFAULT_PROTECTED_TOOLS = ["task", "todowrite", "todoread", "discard", "extract", "batch"]

// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    "enabled",
    "debug",
    "showUpdateToasts", // Deprecated but kept for backwards compatibility
    "pruneNotification",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "tools",
    "tools.settings",
    "tools.settings.nudgeEnabled",
    "tools.settings.nudgeFrequency",
    "tools.settings.protectedTools",
    "tools.settings.activationThreshold",
    "tools.discard",
    "tools.discard.enabled",
    "tools.extract",
    "tools.extract.enabled",
    "tools.extract.showDistillation",
    "strategies",
    // strategies.deduplication
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    // strategies.supersedeWrites
    "strategies.supersedeWrites",
    "strategies.supersedeWrites.enabled",
    // strategies.purgeErrors
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
    // strategies.onIdle
    "strategies.onIdle",
    "strategies.onIdle.enabled",
    "strategies.onIdle.model",
    "strategies.onIdle.showModelErrorToasts",
    "strategies.onIdle.strictModelSelection",
    "strategies.onIdle.protectedTools",
])

// Extract all key paths from a config object for validation
function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

// Type validators for config values
interface ValidationError {
    key: string
    expected: string
    actual: string
}

function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    // Top-level validators
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }
    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }
    if (config.pruneNotification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (!validValues.includes(config.pruneNotification)) {
            errors.push({
                key: "pruneNotification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.pruneNotification),
            })
        }
    }

    // Top-level turnProtection validator
    if (config.turnProtection) {
        if (
            config.turnProtection.enabled !== undefined &&
            typeof config.turnProtection.enabled !== "boolean"
        ) {
            errors.push({
                key: "turnProtection.enabled",
                expected: "boolean",
                actual: typeof config.turnProtection.enabled,
            })
        }
        if (
            config.turnProtection.turns !== undefined &&
            typeof config.turnProtection.turns !== "number"
        ) {
            errors.push({
                key: "turnProtection.turns",
                expected: "number",
                actual: typeof config.turnProtection.turns,
            })
        }
    }

    // Tools validators
    const tools = config.tools
    if (tools) {
        if (tools.settings) {
            if (
                tools.settings.nudgeEnabled !== undefined &&
                typeof tools.settings.nudgeEnabled !== "boolean"
            ) {
                errors.push({
                    key: "tools.settings.nudgeEnabled",
                    expected: "boolean",
                    actual: typeof tools.settings.nudgeEnabled,
                })
            }
            if (
                tools.settings.nudgeFrequency !== undefined &&
                typeof tools.settings.nudgeFrequency !== "number"
            ) {
                errors.push({
                    key: "tools.settings.nudgeFrequency",
                    expected: "number",
                    actual: typeof tools.settings.nudgeFrequency,
                })
            }
            if (
                tools.settings.protectedTools !== undefined &&
                !Array.isArray(tools.settings.protectedTools)
            ) {
                errors.push({
                    key: "tools.settings.protectedTools",
                    expected: "string[]",
                    actual: typeof tools.settings.protectedTools,
                })
            }
            if (
                tools.settings.minToolOutputTokens !== undefined &&
                typeof tools.settings.minToolOutputTokens !== "number"
            ) {
                errors.push({
                    key: "tools.settings.minToolOutputTokens",
                    expected: "number",
                    actual: typeof tools.settings.minToolOutputTokens,
                })
            }
        }
        if (tools.discard) {
            if (tools.discard.enabled !== undefined && typeof tools.discard.enabled !== "boolean") {
                errors.push({
                    key: "tools.discard.enabled",
                    expected: "boolean",
                    actual: typeof tools.discard.enabled,
                })
            }
        }
        if (tools.extract) {
            if (tools.extract.enabled !== undefined && typeof tools.extract.enabled !== "boolean") {
                errors.push({
                    key: "tools.extract.enabled",
                    expected: "boolean",
                    actual: typeof tools.extract.enabled,
                })
            }
            if (
                tools.extract.showDistillation !== undefined &&
                typeof tools.extract.showDistillation !== "boolean"
            ) {
                errors.push({
                    key: "tools.extract.showDistillation",
                    expected: "boolean",
                    actual: typeof tools.extract.showDistillation,
                })
            }
        }
    }

    // Strategies validators
    const strategies = config.strategies
    if (strategies) {
        // deduplication
        if (
            strategies.deduplication?.enabled !== undefined &&
            typeof strategies.deduplication.enabled !== "boolean"
        ) {
            errors.push({
                key: "strategies.deduplication.enabled",
                expected: "boolean",
                actual: typeof strategies.deduplication.enabled,
            })
        }
        if (
            strategies.deduplication?.protectedTools !== undefined &&
            !Array.isArray(strategies.deduplication.protectedTools)
        ) {
            errors.push({
                key: "strategies.deduplication.protectedTools",
                expected: "string[]",
                actual: typeof strategies.deduplication.protectedTools,
            })
        }

        // onIdle
        if (strategies.onIdle) {
            if (
                strategies.onIdle.enabled !== undefined &&
                typeof strategies.onIdle.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.onIdle.enabled",
                    expected: "boolean",
                    actual: typeof strategies.onIdle.enabled,
                })
            }
            if (
                strategies.onIdle.model !== undefined &&
                typeof strategies.onIdle.model !== "string"
            ) {
                errors.push({
                    key: "strategies.onIdle.model",
                    expected: "string",
                    actual: typeof strategies.onIdle.model,
                })
            }
            if (
                strategies.onIdle.showModelErrorToasts !== undefined &&
                typeof strategies.onIdle.showModelErrorToasts !== "boolean"
            ) {
                errors.push({
                    key: "strategies.onIdle.showModelErrorToasts",
                    expected: "boolean",
                    actual: typeof strategies.onIdle.showModelErrorToasts,
                })
            }
            if (
                strategies.onIdle.strictModelSelection !== undefined &&
                typeof strategies.onIdle.strictModelSelection !== "boolean"
            ) {
                errors.push({
                    key: "strategies.onIdle.strictModelSelection",
                    expected: "boolean",
                    actual: typeof strategies.onIdle.strictModelSelection,
                })
            }
            if (
                strategies.onIdle.protectedTools !== undefined &&
                !Array.isArray(strategies.onIdle.protectedTools)
            ) {
                errors.push({
                    key: "strategies.onIdle.protectedTools",
                    expected: "string[]",
                    actual: typeof strategies.onIdle.protectedTools,
                })
            }
        }

        // supersedeWrites
        if (strategies.supersedeWrites) {
            if (
                strategies.supersedeWrites.enabled !== undefined &&
                typeof strategies.supersedeWrites.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.supersedeWrites.enabled",
                    expected: "boolean",
                    actual: typeof strategies.supersedeWrites.enabled,
                })
            }
        }

        // purgeErrors
        if (strategies.purgeErrors) {
            if (
                strategies.purgeErrors.enabled !== undefined &&
                typeof strategies.purgeErrors.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.enabled",
                    expected: "boolean",
                    actual: typeof strategies.purgeErrors.enabled,
                })
            }
            if (
                strategies.purgeErrors.turns !== undefined &&
                typeof strategies.purgeErrors.turns !== "number"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.turns",
                    expected: "number",
                    actual: typeof strategies.purgeErrors.turns,
                })
            }
            if (
                strategies.purgeErrors.protectedTools !== undefined &&
                !Array.isArray(strategies.purgeErrors.protectedTools)
            ) {
                errors.push({
                    key: "strategies.purgeErrors.protectedTools",
                    expected: "string[]",
                    actual: typeof strategies.purgeErrors.protectedTools,
                })
            }
        }
    }

    return errors
}

// Show validation warnings for a config file
function showConfigValidationWarnings(
    ctx: PluginInput,
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
                    title: `DCP: Invalid ${configType}`,
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
    debug: false,
    pruneNotification: "detailed",
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    tools: {
        settings: {
            nudgeEnabled: true,
            nudgeFrequency: 10,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            activationThreshold: 5000,
        },
        discard: {
            enabled: true,
        },
        extract: {
            enabled: true,
            showDistillation: false,
        },
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
        },
        supersedeWrites: {
            enabled: true,
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
        },
        onIdle: {
            enabled: false,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            showModelErrorToasts: true,
            strictModelSelection: false,
        },
    },
}

const GLOBAL_CONFIG_DIR = join(homedir(), ".config", "opencode")
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
        if (parent === current) break
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    // Global: ~/.config/opencode/dcp.jsonc|json
    let globalPath: string | null = null
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        globalPath = GLOBAL_CONFIG_PATH_JSONC
    } else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
        globalPath = GLOBAL_CONFIG_PATH_JSON
    }

    // Custom config directory: $OPENCODE_CONFIG_DIR/dcp.jsonc|json
    let configDirPath: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "dcp.jsonc")
        const configJson = join(opencodeConfigDir, "dcp.json")
        if (existsSync(configJsonc)) {
            configDirPath = configJsonc
        } else if (existsSync(configJson)) {
            configDirPath = configJson
        }
    }

    // Project: <project>/.opencode/dcp.jsonc|json
    let projectPath: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "dcp.jsonc")
            const projectJson = join(opencodeDir, "dcp.json")
            if (existsSync(projectJsonc)) {
                projectPath = projectJsonc
            } else if (existsSync(projectJson)) {
                projectPath = projectJson
            }
        }
    }

    return { global: globalPath, configDir: configDirPath, project: projectPath }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  // Enable or disable the plugin
  "enabled": true,
  // Enable debug logging to ~/.config/opencode/logs/dcp/
  "debug": false,
  // Notification display: "off", "minimal", or "detailed"
  "pruneNotification": "detailed",
  // Protect from pruning for <turns> message turns
  "turnProtection": {
    "enabled": false,
    "turns": 4
  },
  // LLM-driven context pruning tools
  "tools": {
    // Shared settings for all prune tools
    "settings": {
      // Nudge the LLM to use prune tools (every <nudgeFrequency> tool results)
      "nudgeEnabled": true,
      "nudgeFrequency": 10,
      // Additional tools to protect from pruning
      "protectedTools": [],
      // Minimum tool output tokens before injecting prune context
      "activationThreshold": 5000
    },
    // Removes tool content from context without preservation (for completed tasks or noise)
    "discard": {
      "enabled": true
    },
    // Distills key findings into preserved knowledge before removing raw content
    "extract": {
      "enabled": true,
      // Show distillation content as an ignored message notification
      "showDistillation": false
    }
  },
  // Automatic pruning strategies
  "strategies": {
    // Remove duplicate tool calls (same tool with same arguments)
    "deduplication": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": []
    },
    // Prune write tool inputs when the file has been subsequently read
    "supersedeWrites": {
      "enabled": true
    },
    // Prune tool inputs for errored tools after X turns
    "purgeErrors": {
      "enabled": true,
      // Number of turns before errored tool inputs are pruned
      "turns": 4,
      // Additional tools to protect from pruning
      "protectedTools": []
    },
    // (Legacy) Run an LLM to analyze what tool calls are no longer relevant on idle
    "onIdle": {
      "enabled": false,
      // Additional tools to protect from pruning
      "protectedTools": [],
      // Override model for analysis (format: "provider/model")
      // "model": "anthropic/claude-haiku-4-5",
      // Show toast notifications when model selection fails
      "showModelErrorToasts": true,
      // When true, fallback models are not permitted
      "strictModelSelection": false
    }
  }
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent: string
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        // File doesn't exist or can't be read - not a parse error
        return { data: null }
    }

    try {
        const parsed = parse(fileContent)
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function mergeStrategies(
    base: PluginConfig["strategies"],
    override?: Partial<PluginConfig["strategies"]>,
): PluginConfig["strategies"] {
    if (!override) return base

    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            protectedTools: [
                ...new Set([
                    ...base.deduplication.protectedTools,
                    ...(override.deduplication?.protectedTools ?? []),
                ]),
            ],
        },
        supersedeWrites: {
            enabled: override.supersedeWrites?.enabled ?? base.supersedeWrites.enabled,
        },
        purgeErrors: {
            enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
            turns: override.purgeErrors?.turns ?? base.purgeErrors.turns,
            protectedTools: [
                ...new Set([
                    ...base.purgeErrors.protectedTools,
                    ...(override.purgeErrors?.protectedTools ?? []),
                ]),
            ],
        },
        onIdle: {
            enabled: override.onIdle?.enabled ?? base.onIdle.enabled,
            model: override.onIdle?.model ?? base.onIdle.model,
            showModelErrorToasts:
                override.onIdle?.showModelErrorToasts ?? base.onIdle.showModelErrorToasts,
            strictModelSelection:
                override.onIdle?.strictModelSelection ?? base.onIdle.strictModelSelection,
            protectedTools: [
                ...new Set([
                    ...base.onIdle.protectedTools,
                    ...(override.onIdle?.protectedTools ?? []),
                ]),
            ],
        },
    }
}

function mergeTools(
    base: PluginConfig["tools"],
    override?: Partial<PluginConfig["tools"]>,
): PluginConfig["tools"] {
    if (!override) return base

    return {
        settings: {
            nudgeEnabled: override.settings?.nudgeEnabled ?? base.settings.nudgeEnabled,
            nudgeFrequency: override.settings?.nudgeFrequency ?? base.settings.nudgeFrequency,
            protectedTools: [
                ...new Set([
                    ...base.settings.protectedTools,
                    ...(override.settings?.protectedTools ?? []),
                ]),
            ],
            activationThreshold:
                override.settings?.activationThreshold ?? base.settings.activationThreshold,
        },
        discard: {
            enabled: override.discard?.enabled ?? base.discard.enabled,
        },
        extract: {
            enabled: override.extract?.enabled ?? base.extract.enabled,
            showDistillation: override.extract?.showDistillation ?? base.extract.showDistillation,
        },
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        turnProtection: { ...config.turnProtection },
        tools: {
            settings: {
                ...config.tools.settings,
                protectedTools: [...config.tools.settings.protectedTools],
            },
            discard: { ...config.tools.discard },
            extract: { ...config.tools.extract },
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            supersedeWrites: {
                ...config.strategies.supersedeWrites,
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
            onIdle: {
                ...config.strategies.onIdle,
                protectedTools: [...config.strategies.onIdle.protectedTools],
            },
        },
    }
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    // Load and merge global config
    if (configPaths.global) {
        const result = loadConfigFile(configPaths.global)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "DCP: Invalid config",
                            message: `${configPaths.global}\n${result.parseError}\nUsing default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.global, result.data, false)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                pruneNotification: result.data.pruneNotification ?? config.pruneNotification,
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                tools: mergeTools(config.tools, result.data.tools as any),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any),
            }
        }
    } else {
        // No config exists, create default
        createDefaultConfig()
    }

    // Load and merge $OPENCODE_CONFIG_DIR/dcp.jsonc|json (overrides global)
    if (configPaths.configDir) {
        const result = loadConfigFile(configPaths.configDir)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "DCP: Invalid configDir config",
                            message: `${configPaths.configDir}\n${result.parseError}\nUsing global/default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.configDir, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                pruneNotification: result.data.pruneNotification ?? config.pruneNotification,
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                tools: mergeTools(config.tools, result.data.tools as any),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any),
            }
        }
    }

    // Load and merge project config (overrides global)
    if (configPaths.project) {
        const result = loadConfigFile(configPaths.project)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "DCP: Invalid project config",
                            message: `${configPaths.project}\n${result.parseError}\nUsing global/default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.project, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                pruneNotification: result.data.pruneNotification ?? config.pruneNotification,
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                tools: mergeTools(config.tools, result.data.tools as any),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any),
            }
        }
    }

    return config
}
