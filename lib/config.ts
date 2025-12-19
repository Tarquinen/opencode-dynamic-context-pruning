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

export interface PruneToolTurnProtection {
    enabled: boolean
    turns: number
}

export interface PruneTool {
    enabled: boolean
    protectedTools: string[]
    turnProtection: PruneToolTurnProtection
    nudge: PruneToolNudge
}

export interface SupersedeWrites {
    enabled: boolean
}

export interface ProviderStrategies {
    deduplication?: { enabled?: boolean }
    onIdle?: { enabled?: boolean }
    pruneTool?: { enabled?: boolean }
    supersedeWrites?: { enabled?: boolean }
}

export interface ProviderOverride {
    enabled?: boolean
    strategies?: ProviderStrategies
}

export interface Overrides {
    provider?: Record<string, ProviderOverride>
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    pruningSummary: "off" | "minimal" | "detailed"
    overrides: Overrides
    strategies: {
        deduplication: Deduplication
        onIdle: OnIdle
        pruneTool: PruneTool
        supersedeWrites: SupersedeWrites
    }
}

const DEFAULT_PROTECTED_TOOLS = ['task', 'todowrite', 'todoread', 'prune', 'batch']

// Valid config keys for validation against user config
// Note: overrides.provider uses dynamic keys so we validate structure, not exact paths
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    'enabled',
    'debug',
    'showUpdateToasts', // Deprecated but kept for backwards compatibility
    'pruningSummary',
    'overrides',
    'overrides.provider',
    'strategies',
    // strategies.deduplication
    'strategies.deduplication',
    'strategies.deduplication.enabled',
    'strategies.deduplication.protectedTools',
    // strategies.supersedeWrites
    'strategies.supersedeWrites',
    'strategies.supersedeWrites.enabled',
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
    'strategies.pruneTool.turnProtection',
    'strategies.pruneTool.turnProtection.enabled',
    'strategies.pruneTool.turnProtection.turns',
    'strategies.pruneTool.nudge',
    'strategies.pruneTool.nudge.enabled',
    'strategies.pruneTool.nudge.frequency'
])

// Valid keys within overrides.provider.<provider> objects
const VALID_PROVIDER_OVERRIDE_KEYS = new Set([
    'enabled',
    'strategies',
    'strategies.deduplication',
    'strategies.deduplication.enabled',
    'strategies.onIdle',
    'strategies.onIdle.enabled',
    'strategies.pruneTool',
    'strategies.pruneTool.enabled',
    'strategies.supersedeWrites',
    'strategies.supersedeWrites.enabled'
])

// Extract all key paths from a config object for validation
// Skips overrides.provider children since they have dynamic provider keys
function getConfigKeyPaths(obj: Record<string, any>, prefix = ''): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        // Skip deep traversal of overrides.provider - validated separately
        if (fullKey === 'overrides.provider') {
            keys.push(fullKey)
            continue
        }
        keys.push(fullKey)
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

// Validate overrides.provider structure
function getInvalidProviderOverrideKeys(providerOverrides: Record<string, any>): string[] {
    const invalid: string[] = []
    for (const provider of Object.keys(providerOverrides)) {
        const override = providerOverrides[provider]
        if (!override || typeof override !== 'object') continue
        const overrideKeys = getConfigKeyPaths(override)
        for (const key of overrideKeys) {
            if (!VALID_PROVIDER_OVERRIDE_KEYS.has(key)) {
                invalid.push(`overrides.provider.${provider}.${key}`)
            }
        }
    }
    return invalid
}

// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    const invalidTopLevel = userKeys.filter(key => !VALID_CONFIG_KEYS.has(key))
    const invalidProviderOverrides = userConfig.overrides?.provider
        ? getInvalidProviderOverrideKeys(userConfig.overrides.provider)
        : []
    return [...invalidTopLevel, ...invalidProviderOverrides]
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
    if (config.pruningSummary !== undefined) {
        const validValues = ['off', 'minimal', 'detailed']
        if (!validValues.includes(config.pruningSummary)) {
            errors.push({ key: 'pruningSummary', expected: '"off" | "minimal" | "detailed"', actual: JSON.stringify(config.pruningSummary) })
        }
    }
    if (config.overrides !== undefined) {
        if (typeof config.overrides !== 'object' || Array.isArray(config.overrides)) {
            errors.push({ key: 'overrides', expected: 'Overrides object', actual: typeof config.overrides })
        } else if (config.overrides.provider !== undefined) {
            if (typeof config.overrides.provider !== 'object' || Array.isArray(config.overrides.provider)) {
                errors.push({ key: 'overrides.provider', expected: 'Record<string, ProviderOverride>', actual: typeof config.overrides.provider })
            } else {
                // Validate each provider override
                for (const [provider, override] of Object.entries(config.overrides.provider)) {
                    if (typeof override !== 'object' || override === null) {
                        errors.push({ key: `overrides.provider.${provider}`, expected: 'ProviderOverride object', actual: typeof override })
                        continue
                    }
                    const o = override as Record<string, any>
                    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
                        errors.push({ key: `overrides.provider.${provider}.enabled`, expected: 'boolean', actual: typeof o.enabled })
                    }
                    if (o.strategies) {
                        for (const strategy of ['deduplication', 'onIdle', 'pruneTool', 'supersedeWrites']) {
                            if (o.strategies[strategy]?.enabled !== undefined && typeof o.strategies[strategy].enabled !== 'boolean') {
                                errors.push({ key: `overrides.provider.${provider}.strategies.${strategy}.enabled`, expected: 'boolean', actual: typeof o.strategies[strategy].enabled })
                            }
                        }
                    }
                }
            }
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
            if (strategies.pruneTool.turnProtection) {
                if (strategies.pruneTool.turnProtection.enabled !== undefined && typeof strategies.pruneTool.turnProtection.enabled !== 'boolean') {
                    errors.push({ key: 'strategies.pruneTool.turnProtection.enabled', expected: 'boolean', actual: typeof strategies.pruneTool.turnProtection.enabled })
                }
                if (strategies.pruneTool.turnProtection.turns !== undefined && typeof strategies.pruneTool.turnProtection.turns !== 'number') {
                    errors.push({ key: 'strategies.pruneTool.turnProtection.turns', expected: 'number', actual: typeof strategies.pruneTool.turnProtection.turns })
                }
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

        // supersedeWrites
        if (strategies.supersedeWrites) {
            if (strategies.supersedeWrites.enabled !== undefined && typeof strategies.supersedeWrites.enabled !== 'boolean') {
                errors.push({ key: 'strategies.supersedeWrites.enabled', expected: 'boolean', actual: typeof strategies.supersedeWrites.enabled })
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
    pruningSummary: 'detailed',
    overrides: {},
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS]
        },
        supersedeWrites: {
            enabled: true
        },
        pruneTool: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            turnProtection: {
                enabled: false,
                turns: 4
            },
            nudge: {
                enabled: true,
                frequency: 10
            }
        },
        onIdle: {
            enabled: false,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            showModelErrorToasts: true,
            strictModelSelection: false
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

function getConfigPaths(ctx?: PluginInput): { global: string | null, configDir: string | null, project: string | null} {
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
        const configJsonc = join(opencodeConfigDir, 'dcp.jsonc')
        const configJson = join(opencodeConfigDir, 'dcp.json')
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
            const projectJsonc = join(opencodeDir, 'dcp.jsonc')
            const projectJson = join(opencodeDir, 'dcp.json')
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
  // Summary display: "off", "minimal", or "detailed"
  "pruningSummary": "detailed",
  // Per-provider overrides for granular control
  // "overrides": {
  //   "provider": {
  //     "openai": {
  //       "enabled": false  // Disable all DCP features for OpenAI
  //     },
  //     "anthropic": {
  //       "strategies": {
  //         "pruneTool": { "enabled": false }  // Disable only the prune tool for Anthropic
  //       }
  //     }
  //   }
  // },
  // Strategies for pruning tokens from chat history
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
    // Exposes a prune tool to your LLM to call when it determines pruning is necessary
    \"pruneTool\": {
      \"enabled\": true,
      // Additional tools to protect from pruning
      \"protectedTools\": [],
      // Protect from pruning for <turn protection> message turns
      \"turnProtection\": {
        \"enabled\": false,
        \"turns\": 4
      },
      // Nudge the LLM to use the prune tool (every <frequency> tool results)
      \"nudge\": {
        "enabled": true,
        "frequency": 10
      }
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
            turnProtection: {
                enabled: override.pruneTool?.turnProtection?.enabled ?? base.pruneTool.turnProtection.enabled,
                turns: override.pruneTool?.turnProtection?.turns ?? base.pruneTool.turnProtection.turns
            },
            nudge: {
                enabled: override.pruneTool?.nudge?.enabled ?? base.pruneTool.nudge.enabled,
                frequency: override.pruneTool?.nudge?.frequency ?? base.pruneTool.nudge.frequency
            }
        },
        supersedeWrites: {
            enabled: override.supersedeWrites?.enabled ?? base.supersedeWrites.enabled
        }
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        overrides: JSON.parse(JSON.stringify(config.overrides)),
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
                turnProtection: { ...config.strategies.pruneTool.turnProtection },
                nudge: { ...config.strategies.pruneTool.nudge }
            },
            supersedeWrites: {
                ...config.strategies.supersedeWrites
            }
        }
    }
}

function mergeOverrides(
    base: Overrides,
    override?: Overrides
): Overrides {
    if (!override) return base
    const result: Overrides = { ...base }
    if (override.provider) {
        result.provider = result.provider ?? {}
        for (const [provider, overrideConfig] of Object.entries(override.provider)) {
            if (!result.provider[provider]) {
                result.provider[provider] = overrideConfig
            } else {
                result.provider[provider] = {
                    enabled: overrideConfig.enabled ?? result.provider[provider].enabled,
                    strategies: overrideConfig.strategies
                        ? {
                            ...result.provider[provider].strategies,
                            ...overrideConfig.strategies
                        }
                        : result.provider[provider].strategies
                }
            }
        }
    }
    return result
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
                pruningSummary: result.data.pruningSummary ?? config.pruningSummary,
                overrides: mergeOverrides(config.overrides, result.data.overrides),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any)
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
                            duration: 7000
                        }
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.configDir, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                pruningSummary: result.data.pruningSummary ?? config.pruningSummary,
                overrides: mergeOverrides(config.overrides, result.data.overrides),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any)
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
                pruningSummary: result.data.pruningSummary ?? config.pruningSummary,
                overrides: mergeOverrides(config.overrides, result.data.overrides),
                strategies: mergeStrategies(config.strategies, result.data.strategies as any)
            }
        }
    }

    return config
}

export interface EffectiveProviderConfig {
    enabled: boolean
    strategies: {
        deduplication: boolean
        onIdle: boolean
        pruneTool: boolean
        supersedeWrites: boolean
    }
}

/**
 * Computes the effective config for a specific provider, applying overrides.provider.<name>
 */
export function getEffectiveProviderConfig(
    config: PluginConfig,
    providerID: string
): EffectiveProviderConfig {
    // Check for provider-specific overrides
    const override = config.overrides.provider?.[providerID]
    if (override?.enabled === false) {
        return {
            enabled: false,
            strategies: {
                deduplication: false,
                onIdle: false,
                pruneTool: false,
                supersedeWrites: false
            }
        }
    }

    // Apply granular strategy overrides
    return {
        enabled: true,
        strategies: {
            deduplication: override?.strategies?.deduplication?.enabled ?? config.strategies.deduplication.enabled,
            onIdle: override?.strategies?.onIdle?.enabled ?? config.strategies.onIdle.enabled,
            pruneTool: override?.strategies?.pruneTool?.enabled ?? config.strategies.pruneTool.enabled,
            supersedeWrites: override?.strategies?.supersedeWrites?.enabled ?? config.strategies.supersedeWrites.enabled
        }
    }
}
