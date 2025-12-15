import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { parse } from 'jsonc-parser'
import type { PluginInput } from '@opencode-ai/plugin'

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

export interface PruneToolNudge {
    enabled: boolean
    frequency: number
}

export interface PruneTool {
    enabled: boolean
    protectedTools: string[]
    nudge: PruneToolNudge
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    showUpdateToasts?: boolean
    pruningSummary: "off" | "minimal" | "detailed"
    strategies: {
        deduplication: Deduplication
        onIdle: OnIdle
        pruneTool: PruneTool
    }
}

const DEFAULT_PROTECTED_TOOLS = ['task', 'todowrite', 'todoread', 'prune', 'batch', 'write', 'edit']

// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    'enabled',
    'debug',
    'showUpdateToasts',
    'pruningSummary',
    'strategies',
    // strategies.deduplication
    'strategies.deduplication',
    'strategies.deduplication.enabled',
    'strategies.deduplication.protectedTools',
    // strategies.onIdle
    'strategies.onIdle',
    'strategies.onIdle.enabled',
    'strategies.onIdle.model',
    'strategies.onIdle.showModelErrorToasts',
    'strategies.onIdle.strictModelSelection',
    'strategies.onIdle.protectedTools',
    // strategies.pruneTool
    'strategies.pruneTool',
    'strategies.pruneTool.enabled',
    'strategies.pruneTool.protectedTools',
    'strategies.pruneTool.nudge',
    'strategies.pruneTool.nudge.enabled',
    'strategies.pruneTool.nudge.frequency',
])

// Extract all key paths from a config object for validation
function getConfigKeyPaths(obj: Record<string, any>, prefix = ''): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter(key => !VALID_CONFIG_KEYS.has(key))
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
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
        errors.push({ key: 'enabled', expected: 'boolean', actual: typeof config.enabled })
    }
    if (config.debug !== undefined && typeof config.debug !== 'boolean') {
        errors.push({ key: 'debug', expected: 'boolean', actual: typeof config.debug })
    }
    if (config.showUpdateToasts !== undefined && typeof config.showUpdateToasts !== 'boolean') {
        errors.push({ key: 'showUpdateToasts', expected: 'boolean', actual: typeof config.showUpdateToasts })
    }
    if (config.pruningSummary !== undefined) {
        const validValues = ['off', 'minimal', 'detailed']
        if (!validValues.includes(config.pruningSummary)) {
            errors.push({ key: 'pruningSummary', expected: '"off" | "minimal" | "detailed"', actual: JSON.stringify(config.pruningSummary) })
        }
    }

    // Strategies validators
    const strategies = config.strategies
    if (strategies) {
        // deduplication
        if (strategies.deduplication?.enabled !== undefined && typeof strategies.deduplication.enabled !== 'boolean') {
            errors.push({ key: 'strategies.deduplication.enabled', expected: 'boolean', actual: typeof strategies.deduplication.enabled })
        }
        if (strategies.deduplication?.protectedTools !== undefined && !Array.isArray(strategies.deduplication.protectedTools)) {
            errors.push({ key: 'strategies.deduplication.protectedTools', expected: 'string[]', actual: typeof strategies.deduplication.protectedTools })
        }

        // onIdle
        if (strategies.onIdle) {
            if (strategies.onIdle.enabled !== undefined && typeof strategies.onIdle.enabled !== 'boolean') {
                errors.push({ key: 'strategies.onIdle.enabled', expected: 'boolean', actual: typeof strategies.onIdle.enabled })
            }
            if (strategies.onIdle.model !== undefined && typeof strategies.onIdle.model !== 'string') {
                errors.push({ key: 'strategies.onIdle.model', expected: 'string', actual: typeof strategies.onIdle.model })
            }
            if (strategies.onIdle.showModelErrorToasts !== undefined && typeof strategies.onIdle.showModelErrorToasts !== 'boolean') {
                errors.push({ key: 'strategies.onIdle.showModelErrorToasts', expected: 'boolean', actual: typeof strategies.onIdle.showModelErrorToasts })
            }
            if (strategies.onIdle.strictModelSelection !== undefined && typeof strategies.onIdle.strictModelSelection !== 'boolean') {
                errors.push({ key: 'strategies.onIdle.strictModelSelection', expected: 'boolean', actual: typeof strategies.onIdle.strictModelSelection })
            }
            if (strategies.onIdle.protectedTools !== undefined && !Array.isArray(strategies.onIdle.protectedTools)) {
                errors.push({ key: 'strategies.onIdle.protectedTools', expected: 'string[]', actual: typeof strategies.onIdle.protectedTools })
            }
        }

        // pruneTool
        if (strategies.pruneTool) {
            if (strategies.pruneTool.enabled !== undefined && typeof strategies.pruneTool.enabled !== 'boolean') {
                errors.push({ key: 'strategies.pruneTool.enabled', expected: 'boolean', actual: typeof strategies.pruneTool.enabled })
            }
            if (strategies.pruneTool.protectedTools !== undefined && !Array.isArray(strategies.pruneTool.protectedTools)) {
                errors.push({ key: 'strategies.pruneTool.protectedTools', expected: 'string[]', actual: typeof strategies.pruneTool.protectedTools })
            }
            if (strategies.pruneTool.nudge) {
                if (strategies.pruneTool.nudge.enabled !== undefined && typeof strategies.pruneTool.nudge.enabled !== 'boolean') {
                    errors.push({ key: 'strategies.pruneTool.nudge.enabled', expected: 'boolean', actual: typeof strategies.pruneTool.nudge.enabled })
                }
                if (strategies.pruneTool.nudge.frequency !== undefined && typeof strategies.pruneTool.nudge.frequency !== 'number') {
                    errors.push({ key: 'strategies.pruneTool.nudge.frequency', expected: 'number', actual: typeof strategies.pruneTool.nudge.frequency })
                }
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
    isProject: boolean
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? 'project config' : 'config'
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(', ')
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ''
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
                    message: `${configPath}\n${messages.join('\n')}`,
                    variant: "warning",
                    duration: 7000
                }
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    showUpdateToasts: true,
    pruningSummary: 'detailed',
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS]
        },
        pruneTool: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            nudge: {
                enabled: true,
                frequency: 10
            }
        },
        onIdle: {
            enabled: false,
            showModelErrorToasts: true,
            strictModelSelection: false,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS]
        }
    }
}

const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'opencode')
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, 'dcp.jsonc')
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, 'dcp.json')

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== '/') {
        const candidate = join(current, '.opencode')
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): { global: string | null, project: string | null } {
    let globalPath: string | null = null
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        globalPath = GLOBAL_CONFIG_PATH_JSONC
    } else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
        globalPath = GLOBAL_CONFIG_PATH_JSON
    }

    let projectPath: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, 'dcp.jsonc')
            const projectJson = join(opencodeDir, 'dcp.json')
            if (existsSync(projectJsonc)) {
                projectPath = projectJsonc
            } else if (existsSync(projectJson)) {
                projectPath = projectJson
            }
        }
    }

    return { global: globalPath, project: projectPath }
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
  // Show toast notifications when a new version is available
  "showUpdateToasts": true,
  // Summary display: "off", "minimal", or "detailed"
  "pruningSummary": "detailed",
  // Strategies for pruning tokens from chat history
  "strategies": {
    // Remove duplicate tool calls (same tool with same arguments)
    "deduplication": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": []
    },
    // Exposes a prune tool to your LLM to call when it determines pruning is necessary
    "pruneTool": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": [],
      // Nudge the LLM to use the prune tool (every <frequency> tool results)
      "nudge": {
        "enabled": true,
        "frequency": 10
      }
    },
    // (Legacy) Run an LLM to analyze what tool calls are no longer relevant on idle
    "onIdle": {
      "enabled": false,
      // Override model for analysis (format: "provider/model")
      // "model": "anthropic/claude-haiku-4-5",
      // Show toast notifications when model selection fails
      "showModelErrorToasts": true,
      // When true, fallback models are not permitted
      "strictModelSelection": false,
      // Additional tools to protect from pruning
      "protectedTools": []
    }
  }
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, 'utf-8')
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent: string
    try {
        fileContent = readFileSync(configPath, 'utf-8')
    } catch {
        // File doesn't exist or can't be read - not a parse error
        return { data: null }
    }

    try {
        const parsed = parse(fileContent)
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: 'Config file is empty or invalid' }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || 'Failed to parse config' }
    }
}

function mergeStrategies(
    base: PluginConfig['strategies'],
    override?: Partial<PluginConfig['strategies']>
): PluginConfig['strategies'] {
    if (!override) return base

    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            protectedTools: [
                ...new Set([
                    ...base.deduplication.protectedTools,
                    ...(override.deduplication?.protectedTools ?? [])
                ])
            ]
        },
        onIdle: {
            enabled: override.onIdle?.enabled ?? base.onIdle.enabled,
            model: override.onIdle?.model ?? base.onIdle.model,
            showModelErrorToasts: override.onIdle?.showModelErrorToasts ?? base.onIdle.showModelErrorToasts,
            strictModelSelection: override.onIdle?.strictModelSelection ?? base.onIdle.strictModelSelection,
            protectedTools: [
                ...new Set([
                    ...base.onIdle.protectedTools,
                    ...(override.onIdle?.protectedTools ?? [])
                ])
            ]
        },
        pruneTool: {
            enabled: override.pruneTool?.enabled ?? base.pruneTool.enabled,
            protectedTools: [
                ...new Set([
                    ...base.pruneTool.protectedTools,
                    ...(override.pruneTool?.protectedTools ?? [])
                ])
            ],
            nudge: {
                enabled: override.pruneTool?.nudge?.enabled ?? base.pruneTool.nudge.enabled,
                frequency: override.pruneTool?.nudge?.frequency ?? base.pruneTool.nudge.frequency
            }
        }
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools]
            },
            onIdle: {
                ...config.strategies.onIdle,
                protectedTools: [...config.strategies.onIdle.protectedTools]
            },
            pruneTool: {
                ...config.strategies.pruneTool,
                protectedTools: [...config.strategies.pruneTool.protectedTools],
                nudge: { ...config.strategies.pruneTool.nudge }
            }
        }
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
                            duration: 7000
                        }
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.global, result.data, false)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                showUpdateToasts: result.data.showUpdateToasts ?? config.showUpdateToasts,
                pruningSummary: result.data.pruningSummary ?? config.pruningSummary,
                strategies: mergeStrategies(config.strategies, result.data.strategies as any)
            }
        }
    } else {
        // No config exists, create default
        createDefaultConfig()
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
                            duration: 7000
                        }
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.project, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                showUpdateToasts: result.data.showUpdateToasts ?? config.showUpdateToasts,
                pruningSummary: result.data.pruningSummary ?? config.pruningSummary,
                strategies: mergeStrategies(config.strategies, result.data.strategies as any)
            }
        }
    }

    return config
}
