import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { parse } from 'jsonc-parser'
import type { PluginInput } from '@opencode-ai/plugin'

export interface DeduplicationStrategy {
    enabled: boolean
}

export interface PruneThinkingBlocksStrategy {
    enabled: boolean
}

export interface OnIdleStrategy {
    enabled: boolean
    model?: string
    showModelErrorToasts?: boolean
    strictModelSelection?: boolean
    protectedTools: string[]
}

export interface PruneToolStrategy {
    enabled: boolean
    protectedTools: string[]
    nudgeFrequency: number
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    showUpdateToasts?: boolean
    pruningSummary: "off" | "minimal" | "detailed"
    strategies: {
        deduplication: DeduplicationStrategy
        pruneThinkingBlocks: PruneThinkingBlocksStrategy
        onIdle: OnIdleStrategy
        pruneTool: PruneToolStrategy
    }
}

const DEFAULT_PROTECTED_TOOLS = ['task', 'todowrite', 'todoread', 'prune', 'batch', 'write', 'edit']

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    showUpdateToasts: true,
    pruningSummary: 'detailed',
    strategies: {
        deduplication: {
            enabled: true
        },
        pruneThinkingBlocks: {
            enabled: true
        },
        onIdle: {
            enabled: true,
            showModelErrorToasts: true,
            strictModelSelection: false,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS]
        },
        pruneTool: {
            enabled: false,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            nudgeFrequency: 10
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
      "enabled": true
    },
    // Remove thinking/reasoning LLM blocks
    "pruneThinkingBlocks": {
      "enabled": true
    },
    // Run an LLM to analyze what tool calls are no longer relevant on idle
    "onIdle": {
      "enabled": true,
      // Override model for analysis (format: "provider/model")
      // "model": "anthropic/claude-haiku-4-5",
      // Show toast notifications when model selection fails
      "showModelErrorToasts": true,
      // When true, fallback models are not permitted
      "strictModelSelection": false,
      // Additional tools to protect from pruning
      "protectedTools": []
    },
    // Exposes a prune tool to your LLM to call when it determines pruning is necessary
    "pruneTool": {
      "enabled": false,
      // Additional tools to protect from pruning
      "protectedTools": [],
      // How often to nudge the AI to prune (every N tool results, 0 = disabled)
      "nudgeFrequency": 10
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
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled
        },
        pruneThinkingBlocks: {
            enabled: override.pruneThinkingBlocks?.enabled ?? base.pruneThinkingBlocks.enabled
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
            nudgeFrequency: override.pruneTool?.nudgeFrequency ?? base.pruneTool.nudgeFrequency
        }
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        strategies: {
            deduplication: { ...config.strategies.deduplication },
            pruneThinkingBlocks: { ...config.strategies.pruneThinkingBlocks },
            onIdle: {
                ...config.strategies.onIdle,
                protectedTools: [...config.strategies.onIdle.protectedTools]
            },
            pruneTool: {
                ...config.strategies.pruneTool,
                protectedTools: [...config.strategies.pruneTool.protectedTools]
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
            ctx.client.tui.showToast({
                body: {
                    title: "DCP: Invalid config",
                    message: `${configPaths.global}\n${result.parseError}\nUsing default values`,
                    variant: "warning",
                    duration: 7000
                }
            }).catch(() => {})
        } else if (result.data) {
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
            ctx.client.tui.showToast({
                body: {
                    title: "DCP: Invalid project config",
                    message: `${configPaths.project}\n${result.parseError}\nUsing global/default values`,
                    variant: "warning",
                    duration: 7000
                }
            }).catch(() => {})
        } else if (result.data) {
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
