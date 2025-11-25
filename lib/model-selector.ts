/**
 * Model Selection and Fallback Logic
 * 
 * This module handles intelligent model selection for the DCP plugin's analysis tasks.
 * It attempts to use the same model as the current session, with fallbacks to other
 * available models when needed.
 * 
 * NOTE: OpencodeAI is lazily imported to avoid loading the 812KB package during
 * plugin initialization. The package is only loaded when model selection is needed.
 */

import type { LanguageModel } from 'ai';
import type { Logger } from './logger';

export interface ModelInfo {
    providerID: string;
    modelID: string;
}

/**
 * Fallback models to try in priority order
 * Earlier entries are tried first
 */
export const FALLBACK_MODELS: Record<string, string> = {
    openai: 'gpt-5-mini',
    anthropic: 'claude-haiku-4-5',
    google: 'gemini-2.5-flash',
    deepseek: 'deepseek-chat',
    xai: 'grok-4-fast',
    alibaba: 'qwen3-coder-flash',
    zai: 'glm-4.5-flash',
    opencode: 'big-pickle'
};

const PROVIDER_PRIORITY = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'xai',
    'alibaba',
    'zai',
    'opencode'
];

/**
 * Providers to skip for background analysis
 * These providers are either expensive or not suitable for background tasks
 */
const SKIP_PROVIDERS = ['github-copilot', 'anthropic'];

export interface ModelSelectionResult {
    model: LanguageModel;
    modelInfo: ModelInfo;
    source: 'user-model' | 'config' | 'fallback';
    reason?: string;
    failedModel?: ModelInfo; // The model that failed, if any
}

/**
 * Checks if a provider should be skipped for background analysis
 */
function shouldSkipProvider(providerID: string): boolean {
    const normalized = providerID.toLowerCase().trim();
    return SKIP_PROVIDERS.some(skip => normalized.includes(skip.toLowerCase()));
}

/**
 * Attempts to import OpencodeAI with retry logic to handle plugin initialization timing issues.
 * Some providers (like openai via @openhax/codex) may not be fully initialized on first attempt.
 */
async function importOpencodeAI(logger?: Logger, maxRetries: number = 3, delayMs: number = 100, workspaceDir?: string): Promise<any> {
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const { OpencodeAI } = await import('@tarquinen/opencode-auth-provider');
            return new OpencodeAI({ workspaceDir });
        } catch (error: any) {
            lastError = error;
            
            // Check if this is the specific initialization error we're handling
            if (error.message?.includes('before initialization')) {
                logger?.debug('model-selector', `Import attempt ${attempt}/${maxRetries} failed, will retry`, {
                    error: error.message
                });
                
                if (attempt < maxRetries) {
                    // Wait before retrying, with exponential backoff
                    await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
                    continue;
                }
            }
            
            // For other errors, don't retry
            throw error;
        }
    }
    
    // All retries exhausted
    throw lastError;
}

/**
 * Main model selection function with intelligent fallback logic
 * 
 * Selection hierarchy:
 * 1. Try the config-specified model (if provided in dcp.jsonc)
 * 2. Try the user's current model (skip if github-copilot or anthropic)
 * 3. Try fallback models from authenticated providers (in priority order)
 * 
 * @param currentModel - The model being used in the current session (optional)
 * @param logger - Logger instance for debug output
 * @param configModel - Model string in "provider/model" format (e.g., "anthropic/claude-haiku-4-5")
 * @returns Selected model with metadata about the selection
 */
export async function selectModel(
    currentModel?: ModelInfo, 
    logger?: Logger,
    configModel?: string,
    workspaceDir?: string
): Promise<ModelSelectionResult> {
    // Lazy import with retry logic - handles plugin initialization timing issues
    // Some providers (like openai via @openhax/codex) may not be ready on first attempt
    // Pass workspaceDir so OpencodeAI can find project-level config and plugins
    const opencodeAI = await importOpencodeAI(logger, 3, 100, workspaceDir);

    let failedModelInfo: ModelInfo | undefined;

    // Step 1: Try config-specified model first (highest priority)
    if (configModel) {
        const parts = configModel.split('/');
        if (parts.length !== 2) {
            logger?.warn('model-selector', 'Invalid config model format', { configModel });
        } else {
            const [providerID, modelID] = parts;

            try {
                const model = await opencodeAI.getLanguageModel(providerID, modelID);
                return {
                    model,
                    modelInfo: { providerID, modelID },
                    source: 'config',
                    reason: 'Using model specified in dcp.jsonc config'
                };
            } catch (error: any) {
                logger?.warn('model-selector', `Config model failed: ${providerID}/${modelID}`, {
                    error: error.message
                });
                failedModelInfo = { providerID, modelID };
            }
        }
    }

    // Step 2: Try user's current model (if not skipped provider)
    if (currentModel) {
        if (shouldSkipProvider(currentModel.providerID)) {
            // Track as failed so we can show toast
            if (!failedModelInfo) {
                failedModelInfo = currentModel;
            }
        } else {
            try {
                const model = await opencodeAI.getLanguageModel(currentModel.providerID, currentModel.modelID);
                return {
                    model,
                    modelInfo: currentModel,
                    source: 'user-model',
                    reason: 'Using current session model'
                };
            } catch (error: any) {
                if (!failedModelInfo) {
                    failedModelInfo = currentModel;
                }
            }
        }
    }

    // Step 3: Try fallback models from authenticated providers
    const providers = await opencodeAI.listProviders();

    for (const providerID of PROVIDER_PRIORITY) {
        if (!providers[providerID]) continue;

        const fallbackModelID = FALLBACK_MODELS[providerID];
        if (!fallbackModelID) continue;

        try {
            const model = await opencodeAI.getLanguageModel(providerID, fallbackModelID);
            return {
                model,
                modelInfo: { providerID, modelID: fallbackModelID },
                source: 'fallback',
                reason: `Using ${providerID}/${fallbackModelID}`,
                failedModel: failedModelInfo
            };
        } catch (error: any) {
            continue;
        }
    }

    throw new Error('No available models for analysis. Please authenticate with at least one provider.');
}

/**
 * Helper to extract model info from OpenCode session state
 * This can be used by the plugin to get the current session's model
 */
export function extractModelFromSession(sessionState: any, logger?: Logger): ModelInfo | undefined {
    // Try to get from ACP session state
    if (sessionState?.model?.providerID && sessionState?.model?.modelID) {
        return {
            providerID: sessionState.model.providerID,
            modelID: sessionState.model.modelID
        };
    }

    // Try to get from last message
    if (sessionState?.messages && Array.isArray(sessionState.messages)) {
        const lastMessage = sessionState.messages[sessionState.messages.length - 1];
        if (lastMessage?.model?.providerID && lastMessage?.model?.modelID) {
            return {
                providerID: lastMessage.model.providerID,
                modelID: lastMessage.model.modelID
            };
        }
    }

    return undefined;
}
