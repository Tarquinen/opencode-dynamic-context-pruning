// lib/config.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { parse } from 'jsonc-parser'
import { Logger } from './logger'
import type { PluginInput } from '@opencode-ai/plugin'

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    protectedTools: string[]
    model?: string // Format: "provider/model" (e.g., "anthropic/claude-haiku-4-5")
    showModelErrorToasts?: boolean // Show toast notifications when model selection fails
    pruningMode: "auto" | "smart" // Pruning strategy: auto (deduplication only) or smart (deduplication + LLM analysis)
    pruning_summary: "off" | "minimal" | "detailed" // UI summary display mode
}

const defaultConfig: PluginConfig = {
    enabled: true, // Plugin is enabled by default
    debug: false, // Disable debug logging by default
    protectedTools: ['task', 'todowrite', 'todoread'], // Tools that should never be pruned (including stateful tools)
    showModelErrorToasts: true, // Show model error toasts by default
    pruningMode: 'smart', // Default to smart mode (deduplication + LLM analysis)
    pruning_summary: 'detailed' // Default to detailed summary
}

const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'opencode')
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, 'dcp.jsonc')
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, 'dcp.json')

/**
 * Searches for .opencode directory starting from current directory and going up
 * Returns the path to .opencode directory if found, null otherwise
 */
function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== '/') {
        const candidate = join(current, '.opencode')
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break // Reached root
        current = parent
    }
    return null
}

/**
 * Determines which config file to use (prefers .jsonc, falls back to .json)
 * Checks both project-level and global configs
 */
function getConfigPaths(ctx?: PluginInput): { global: string | null, project: string | null } {
    // Global config paths
    let globalPath: string | null = null
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        globalPath = GLOBAL_CONFIG_PATH_JSONC
    } else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
        globalPath = GLOBAL_CONFIG_PATH_JSON
    }

    // Project config paths (if context provided)
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

/**
 * Creates the default configuration file with helpful comments
 */
function createDefaultConfig(): void {
    // Ensure the directory exists
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  // Enable or disable the Dynamic Context Pruning plugin
  "enabled": true,

  // Enable debug logging to ~/.config/opencode/logs/dcp/
  // Outputs include:
  // - daily/YYYY-MM-DD.log (plugin activity, decisions, errors)
  // - ai-context/*.json (messages sent to AI after pruning)
  "debug": false,

  // Optional: Specify a model to use for analysis instead of the session model
  // Format: "provider/model" (same as agent model config in opencode.jsonc)
  // NOTE: Anthropic OAuth sonnet 4+ tier models are currently not supported
  // "model": "anthropic/claude-haiku-4-5",

  // Show toast notifications when model selection fails and falls back
  // Set to false to disable these informational toasts
  "showModelErrorToasts": true,

  // Pruning strategy:
  // "auto": Automatic duplicate removal only (fast, no LLM cost)
  // "smart": Deduplication + AI analysis for intelligent pruning (recommended)
  "pruningMode": "smart",

  // Pruning summary display mode:
  // "off": No UI summary (silent pruning)
  // "minimal": Show tokens saved and count (e.g., "Saved ~2.5K tokens (6 tools pruned)")
  // "detailed": Show full breakdown by tool type and pruning method (default)
  "pruning_summary": "detailed",

  // List of tools that should never be pruned from context
  // "task": Each subagent invocation is intentional
  // "todowrite"/"todoread": Stateful tools where each call matters
  "protectedTools": ["task", "todowrite", "todoread"]
}
`

    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, 'utf-8')
}

/**
 * Loads a single config file and parses it
 */
function loadConfigFile(configPath: string): Partial<PluginConfig> | null {
    try {
        const fileContent = readFileSync(configPath, 'utf-8')
        return parse(fileContent) as Partial<PluginConfig>
    } catch (error: any) {
        return null
    }
}

/**
 * Loads configuration with support for both global and project-level configs
 * 
 * Config resolution order:
 * 1. Start with default config
 * 2. Merge with global config (~/.config/opencode/dcp.jsonc)
 * 3. Merge with project config (.opencode/dcp.jsonc) if found
 * 
 * Project config overrides global config, which overrides defaults.
 * 
 * @param ctx - Plugin input context (optional). If provided, will search for project-level config.
 * @returns Merged configuration
 */
export function getConfig(ctx?: PluginInput): PluginConfig {
    let config = { ...defaultConfig }
    const configPaths = getConfigPaths(ctx)
    const logger = new Logger(true) // Always log config loading

    // 1. Load global config
    if (configPaths.global) {
        const globalConfig = loadConfigFile(configPaths.global)
        if (globalConfig) {
            config = {
                enabled: globalConfig.enabled ?? config.enabled,
                debug: globalConfig.debug ?? config.debug,
                protectedTools: globalConfig.protectedTools ?? config.protectedTools,
                model: globalConfig.model ?? config.model,
                showModelErrorToasts: globalConfig.showModelErrorToasts ?? config.showModelErrorToasts,
                pruningMode: globalConfig.pruningMode ?? config.pruningMode,
                pruning_summary: globalConfig.pruning_summary ?? config.pruning_summary
            }
            logger.info('config', 'Loaded global config', { path: configPaths.global })
        }
    } else {
        // Create default global config if it doesn't exist
        createDefaultConfig()
        logger.info('config', 'Created default global config', { path: GLOBAL_CONFIG_PATH_JSONC })
    }

    // 2. Load project config (overrides global)
    if (configPaths.project) {
        const projectConfig = loadConfigFile(configPaths.project)
        if (projectConfig) {
            config = {
                enabled: projectConfig.enabled ?? config.enabled,
                debug: projectConfig.debug ?? config.debug,
                protectedTools: projectConfig.protectedTools ?? config.protectedTools,
                model: projectConfig.model ?? config.model,
                showModelErrorToasts: projectConfig.showModelErrorToasts ?? config.showModelErrorToasts,
                pruningMode: projectConfig.pruningMode ?? config.pruningMode,
                pruning_summary: projectConfig.pruning_summary ?? config.pruning_summary
            }
            logger.info('config', 'Loaded project config (overrides global)', { path: configPaths.project })
        }
    } else if (ctx?.directory) {
        logger.debug('config', 'No project config found', { searchedFrom: ctx.directory })
    }

    return config
}
