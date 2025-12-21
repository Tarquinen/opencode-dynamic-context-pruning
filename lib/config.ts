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

export interface DiscardTool {
    enabled: boolean
    protectedTools: string[]
    turnProtection: PruneToolTurnProtection
    nudge: PruneToolNudge
}

export interface ExtractTool {
    enabled: boolean
    protectedTools: string[]
    turnProtection: PruneToolTurnProtection
    nudge: PruneToolNudge
    showDistillation: boolean
}

export interface SupersedeWrites {
    enabled: boolean
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    pruningSummary: "off" | "minimal" | "detailed"
    strategies: {
        deduplication: Deduplication
        onIdle: OnIdle
        discardTool: DiscardTool
        extractTool: ExtractTool
        supersedeWrites: SupersedeWrites
    }
}

const DEFAULT_PROTECTED_TOOLS = ['task', 'todowrite', 'todoread', 'discard', 'extract', 'batch']

// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    'enabled',
    'debug',
    'showUpdateToasts', // Deprecated but kept for backwards compatibility
    'pruningSummary',
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
    // strategies.discardTool
    'strategies.discardTool',
    'strategies.discardTool.enabled',
    'strategies.discardTool.protectedTools',
    'strategies.discardTool.turnProtection',
    'strategies.discardTool.turnProtection.enabled',
    'strategies.discardTool.turnProtection.turns',
    'strategies.discardTool.nudge',
    'strategies.discardTool.nudge.enabled',
    'strategies.discardTool.nudge.frequency',
    // strategies.extractTool
    'strategies.extractTool',
    'strategies.extractTool.enabled',
    'strategies.extractTool.protectedTools',
    'strategies.extractTool.turnProtection',
    'strategies.extractTool.turnProtection.enabled',
    'strategies.extractTool.turnProtection.turns',
    'strategies.extractTool.nudge',
    'strategies.extractTool.nudge.enabled',
    'strategies.extractTool.nudge.frequency',
    'strategies.extractTool.showDistillation'
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

        // discardTool
        if (strategies.discardTool) {
            if (strategies.discardTool.enabled !== undefined && typeof strategies.discardTool.enabled !== 'boolean') {
                errors.push({ key: 'strategies.discardTool.enabled', expected: 'boolean', actual: typeof strategies.discardTool.enabled })
            }
            if (strategies.discardTool.protectedTools !== undefined && !Array.isArray(strategies.discardTool.protectedTools)) {
                errors.push({ key: 'strategies.discardTool.protectedTools', expected: 'string[]', actual: typeof strategies.discardTool.protectedTools })
            }
            if (strategies.discardTool.turnProtection) {
                if (strategies.discardTool.turnProtection.enabled !== undefined && typeof strategies.discardTool.turnProtection.enabled !== 'boolean') {
                    errors.push({ key: 'strategies.discardTool.turnProtection.enabled', expected: 'boolean', actual: typeof strategies.discardTool.turnProtection.enabled })
                }
                if (strategies.discardTool.turnProtection.turns !== undefined && typeof strategies.discardTool.turnProtection.turns !== 'number') {
                    errors.push({ key: 'strategies.discardTool.turnProtection.turns', expected: 'number', actual: typeof strategies.discardTool.turnProtection.turns })
                }
            }
            if (strategies.discardTool.nudge) {
                if (strategies.discardTool.nudge.enabled !== undefined && typeof strategies.discardTool.nudge.enabled !== 'boolean') {
                    errors.push({ key: 'strategies.discardTool.nudge.enabled', expected: 'boolean', actual: typeof strategies.discardTool.nudge.enabled })
                }
                if (strategies.discardTool.nudge.frequency !== undefined && typeof strategies.discardTool.nudge.frequency !== 'number') {
                    errors.push({ key: 'strategies.discardTool.nudge.frequency', expected: 'number', actual: typeof strategies.discardTool.nudge.frequency })
                }
            }
        }

        // extractTool
        if (strategies.extractTool) {
            if (strategies.extractTool.enabled !== undefined && typeof strategies.extractTool.enabled !== 'boolean') {
                errors.push({ key: 'strategies.extractTool.enabled', expected: 'boolean', actual: typeof strategies.extractTool.enabled })
            }
            if (strategies.extractTool.protectedTools !== undefined && !Array.isArray(strategies.extractTool.protectedTools)) {
                errors.push({ key: 'strategies.extractTool.protectedTools', expected: 'string[]', actual: typeof strategies.extractTool.protectedTools })
            }
            if (strategies.extractTool.turnProtection) {
                if (strategies.extractTool.turnProtection.enabled !== undefined && typeof strategies.extractTool.turnProtection.enabled !== 'boolean') {
                    errors.push({ key: 'strategies.extractTool.turnProtection.enabled', expected: 'boolean', actual: typeof strategies.extractTool.turnProtection.enabled })
                }
                if (strategies.extractTool.turnProtection.turns !== undefined && typeof strategies.extractTool.turnProtection.turns !== 'number') {
                    errors.push({ key: 'strategies.extractTool.turnProtection.turns', expected: 'number', actual: typeof strategies.extractTool.turnProtection.turns })
                }
            }
            if (strategies.extractTool.nudge) {
                if (strategies.extractTool.nudge.enabled !== undefined && typeof strategies.extractTool.nudge.enabled !== 'boolean') {
                    errors.push({ key: 'strategies.extractTool.nudge.enabled', expected: 'boolean', actual: typeof strategies.extractTool.nudge.enabled })
                }
                if (strategies.extractTool.nudge.frequency !== undefined && typeof strategies.extractTool.nudge.frequency !== 'number') {
                    errors.push({ key: 'strategies.extractTool.nudge.frequency', expected: 'number', actual: typeof strategies.extractTool.nudge.frequency })
                }
            }
            if (strategies.extractTool.showDistillation !== undefined && typeof strategies.extractTool.showDistillation !== 'boolean') {
                errors.push({ key: 'strategies.extractTool.showDistillation', expected: 'boolean', actual: typeof strategies.extractTool.showDistillation })
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
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS]
        },
        supersedeWrites: {
            enabled: true
        },
        discardTool: {
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
        extractTool: {
            enabled: true,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            turnProtection: {
                enabled: false,
                turns: 4
            },
            nudge: {
                enabled: true,
                frequency: 10
            },
            showDistillation: false
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
    // Removes tool content from context without preservation (for completed tasks or noise)
    "discardTool": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": [],
      // Protect from pruning for <turn protection> message turns
      "turnProtection": {
        "enabled": false,
        "turns": 4
      },
      // Nudge the LLM to use the discard tool (every <frequency> tool results)
      "nudge": {
        "enabled": true,
        "frequency": 10
      }
    },
    // Distills key findings into preserved knowledge before removing raw content
    "extractTool": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": [],
      // Protect from pruning for <turn protection> message turns
      "turnProtection": {
        "enabled": false,
        "turns": 4
      },
      // Nudge the LLM to use the extract tool (every <frequency> tool results)
      "nudge": {
        "enabled": true,
        "frequency": 10
      },
      // Show distillation content as an ignored message notification
      "showDistillation": false
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
        discardTool: {
            enabled: override.discardTool?.enabled ?? base.discardTool.enabled,
            protectedTools: [
                ...new Set([
                    ...base.discardTool.protectedTools,
                    ...(override.discardTool?.protectedTools ?? [])
                ])
            ],
            turnProtection: {
                enabled: override.discardTool?.turnProtection?.enabled ?? base.discardTool.turnProtection.enabled,
                turns: override.discardTool?.turnProtection?.turns ?? base.discardTool.turnProtection.turns
            },
            nudge: {
                enabled: override.discardTool?.nudge?.enabled ?? base.discardTool.nudge.enabled,
                frequency: override.discardTool?.nudge?.frequency ?? base.discardTool.nudge.frequency
            }
        },
        extractTool: {
            enabled: override.extractTool?.enabled ?? base.extractTool.enabled,
            protectedTools: [
                ...new Set([
                    ...base.extractTool.protectedTools,
                    ...(override.extractTool?.protectedTools ?? [])
                ])
            ],
            turnProtection: {
                enabled: override.extractTool?.turnProtection?.enabled ?? base.extractTool.turnProtection.enabled,
                turns: override.extractTool?.turnProtection?.turns ?? base.extractTool.turnProtection.turns
            },
            nudge: {
                enabled: override.extractTool?.nudge?.enabled ?? base.extractTool.nudge.enabled,
                frequency: override.extractTool?.nudge?.frequency ?? base.extractTool.nudge.frequency
            },
            showDistillation: override.extractTool?.showDistillation ?? base.extractTool.showDistillation
        },
        supersedeWrites: {
            enabled: override.supersedeWrites?.enabled ?? base.supersedeWrites.enabled
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
            discardTool: {
                ...config.strategies.discardTool,
                protectedTools: [...config.strategies.discardTool.protectedTools],
                turnProtection: { ...config.strategies.discardTool.turnProtection },
                nudge: { ...config.strategies.discardTool.nudge }
            },
            extractTool: {
                ...config.strategies.extractTool,
                protectedTools: [...config.strategies.extractTool.protectedTools],
                turnProtection: { ...config.strategies.extractTool.turnProtection },
                nudge: { ...config.strategies.extractTool.nudge },
                showDistillation: config.strategies.extractTool.showDistillation
            },
            supersedeWrites: {
                ...config.strategies.supersedeWrites
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
                pruningSummary: result.data.pruningSummary ?? config.pruningSummary,
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
                strategies: mergeStrategies(config.strategies, result.data.strategies as any)
            }
        }
    }

    return config
}
