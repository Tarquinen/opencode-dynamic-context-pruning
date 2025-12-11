import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { parse } from 'jsonc-parser'
import { Logger } from './logger'
import type { PluginInput } from '@opencode-ai/plugin'

export type PruningStrategy = "deduplication" | "ai-analysis"

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    protectedTools: string[]
    model?: string
    showModelErrorToasts?: boolean
    showUpdateToasts?: boolean
    strictModelSelection?: boolean
    pruning_summary: "off" | "minimal" | "detailed"
    nudge_freq: number
    strategies: {
        onIdle: PruningStrategy[]
        onTool: PruningStrategy[]
    }
}

export interface ConfigResult {
    config: PluginConfig
    migrations: string[]
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    protectedTools: ['task', 'todowrite', 'todoread', 'prune', 'batch', 'write', 'edit'],
    showModelErrorToasts: true,
    showUpdateToasts: true,
    strictModelSelection: false,
    pruning_summary: 'detailed',
    nudge_freq: 10,
    strategies: {
        onIdle: ['ai-analysis'],
        onTool: ['ai-analysis']
    }
}

const VALID_CONFIG_KEYS = new Set([
    'enabled',
    'debug',
    'protectedTools',
    'model',
    'showModelErrorToasts',
    'showUpdateToasts',
    'strictModelSelection',
    'pruning_summary',
    'nudge_freq',
    'strategies'
])

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
  // Override model for analysis (format: "provider/model", e.g. "anthropic/claude-haiku-4-5")
  // "model": "anthropic/claude-haiku-4-5",
  // Show toast notifications when model selection fails
  "showModelErrorToasts": true,
  // Show toast notifications when a new version is available
  "showUpdateToasts": true,
  // Only run AI analysis with session model or configured model (disables fallback models)
  "strictModelSelection": false,
  // AI analysis strategies (deduplication runs automatically on every request)
  "strategies": {
    // Strategies to run when session goes idle
    "onIdle": ["ai-analysis"],
    // Strategies to run when AI calls prune tool
    "onTool": ["ai-analysis"]
  },
  // Summary display: "off", "minimal", or "detailed"
  "pruning_summary": "detailed",
  // How often to nudge the AI to prune (every N tool results, 0 = disabled)
  "nudge_freq": 10
  // Additional tools to protect from pruning
  // "protectedTools": ["bash"]
}
`

    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, 'utf-8')
}

function loadConfigFile(configPath: string): Record<string, any> | null {
    try {
        const fileContent = readFileSync(configPath, 'utf-8')
        return parse(fileContent)
    } catch (error: any) {
        return null
    }
}

function getInvalidKeys(config: Record<string, any>): string[] {
    const invalidKeys: string[] = []
    for (const key of Object.keys(config)) {
        if (!VALID_CONFIG_KEYS.has(key)) {
            invalidKeys.push(key)
        }
    }
    return invalidKeys
}

function backupAndResetConfig(configPath: string, logger: Logger): string | null {
    try {
        const backupPath = configPath + '.bak'
        copyFileSync(configPath, backupPath)
        logger.info('config', 'Created config backup', { backup: backupPath })
        createDefaultConfig()
        logger.info('config', 'Created fresh default config', { path: GLOBAL_CONFIG_PATH_JSONC })
        return backupPath
    } catch (error: any) {
        logger.error('config', 'Failed to backup/reset config', { error: error.message })
        return null
    }
}

function mergeStrategies(
    base: PluginConfig['strategies'],
    override?: Partial<PluginConfig['strategies']>
): PluginConfig['strategies'] {
    if (!override) return base
    return {
        onIdle: override.onIdle ?? base.onIdle,
        onTool: override.onTool ?? base.onTool
    }
}

export function getConfig(ctx?: PluginInput): ConfigResult {
    let config = { ...defaultConfig, protectedTools: [...defaultConfig.protectedTools] }
    const configPaths = getConfigPaths(ctx)
    const logger = new Logger(true)
    const migrations: string[] = []

    if (configPaths.global) {
        const globalConfig = loadConfigFile(configPaths.global)
        if (globalConfig) {
            const invalidKeys = getInvalidKeys(globalConfig)

            if (invalidKeys.length > 0) {
                logger.info('config', 'Found invalid config keys', { keys: invalidKeys })
                const backupPath = backupAndResetConfig(configPaths.global, logger)
                if (backupPath) {
                    migrations.push(`Old config backed up to ${backupPath}`)
                }
            } else {
                config = {
                    enabled: globalConfig.enabled ?? config.enabled,
                    debug: globalConfig.debug ?? config.debug,
                    protectedTools: [...new Set([...config.protectedTools, ...(globalConfig.protectedTools ?? [])])],
                    model: globalConfig.model ?? config.model,
                    showModelErrorToasts: globalConfig.showModelErrorToasts ?? config.showModelErrorToasts,
                    showUpdateToasts: globalConfig.showUpdateToasts ?? config.showUpdateToasts,
                    strictModelSelection: globalConfig.strictModelSelection ?? config.strictModelSelection,
                    strategies: mergeStrategies(config.strategies, globalConfig.strategies as any),
                    pruning_summary: globalConfig.pruning_summary ?? config.pruning_summary,
                    nudge_freq: globalConfig.nudge_freq ?? config.nudge_freq
                }
                logger.info('config', 'Loaded global config', { path: configPaths.global })
            }
        }
    } else {
        createDefaultConfig()
        logger.info('config', 'Created default global config', { path: GLOBAL_CONFIG_PATH_JSONC })
    }

    // Config dir: $OPENCODE_CONFIG_DIR/dcp.jsonc|json (overrides global)
    if (configPaths.configDir) {
        const configDirConfig = loadConfigFile(configPaths.configDir)
        if (configDirConfig) {
            const invalidKeys = getInvalidKeys(configDirConfig)
            if (invalidKeys.length > 0) {
                logger.warn('config', 'Config-dir config has invalid keys (ignored)', {
                  path: configPaths.configDir,
                  keys: invalidKeys
                })
                migrations.push(`Config-dir config has invalid keys: ${invalidKeys.join(', ')}`)
            } else {
                config = {
                    enabled: configDirConfig.enabled ?? config.enabled,
                    debug: configDirConfig.debug ?? config.debug,
                    protectedTools: [...new Set([...config.protectedTools, ...(configDirConfig.protectedTools ?? [])])],
                    model: configDirConfig.model ?? config.model,
                    showModelErrorToasts: configDirConfig.showModelErrorToasts ?? config.showModelErrorToasts,
                    showUpdateToasts: configDirConfig.showUpdateToasts ?? config.showUpdateToasts,
                    strictModelSelection: configDirConfig.strictModelSelection ?? config.strictModelSelection,
                    strategies: mergeStrategies(config.strategies, configDirConfig.strategies as any),
                    pruning_summary: configDirConfig.pruning_summary ?? config.pruning_summary,
                    nudge_freq: configDirConfig.nudge_freq ?? config.nudge_freq
                }
                logger.info('config', 'Loaded config-dir config (overrides global)', { path: configPaths.configDir })
            }
        }
    }

    if (configPaths.project) {
        const projectConfig = loadConfigFile(configPaths.project)
        if (projectConfig) {
            const invalidKeys = getInvalidKeys(projectConfig)

            if (invalidKeys.length > 0) {
                logger.warn('config', 'Project config has invalid keys (ignored)', {
                    path: configPaths.project,
                    keys: invalidKeys
                })
                migrations.push(`Project config has invalid keys: ${invalidKeys.join(', ')}`)
            } else {
                config = {
                    enabled: projectConfig.enabled ?? config.enabled,
                    debug: projectConfig.debug ?? config.debug,
                    protectedTools: [...new Set([...config.protectedTools, ...(projectConfig.protectedTools ?? [])])],
                    model: projectConfig.model ?? config.model,
                    showModelErrorToasts: projectConfig.showModelErrorToasts ?? config.showModelErrorToasts,
                    showUpdateToasts: projectConfig.showUpdateToasts ?? config.showUpdateToasts,
                    strictModelSelection: projectConfig.strictModelSelection ?? config.strictModelSelection,
                    strategies: mergeStrategies(config.strategies, projectConfig.strategies as any),
                    pruning_summary: projectConfig.pruning_summary ?? config.pruning_summary,
                    nudge_freq: projectConfig.nudge_freq ?? config.nudge_freq
                }
                logger.info('config', 'Loaded project config (overrides global + config-dir)', { path: configPaths.project })
            }
        }
    } else if (ctx?.directory) {
        logger.debug('config', 'No project config found', { searchedFrom: ctx.directory })
    }

    return { config, migrations }
}
