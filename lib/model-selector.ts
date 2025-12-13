import type { LanguageModel } from 'ai';
import type { Logger } from './logger';

export interface ModelInfo {
    providerID: string;
    modelID: string;
}

export const FALLBACK_MODELS: Record<string, string> = {
    openai: 'gpt-5-mini',
    anthropic: 'claude-haiku-4-5', //This model isn't broken in opencode-auth-provider
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

// TODO: some anthropic provided models aren't supported by the opencode-auth-provider package, so this provides a temporary workaround
const SKIP_PROVIDERS = ['github-copilot', 'anthropic'];

export interface ModelSelectionResult {
    model: LanguageModel;
    modelInfo: ModelInfo;
    source: 'user-model' | 'config' | 'fallback';
    reason?: string;
    failedModel?: ModelInfo;
}

function shouldSkipProvider(providerID: string): boolean {
    const normalized = providerID.toLowerCase().trim();
    return SKIP_PROVIDERS.some(skip => normalized.includes(skip.toLowerCase()));
}

async function importOpencodeAI(logger?: Logger, maxRetries: number = 3, delayMs: number = 100, workspaceDir?: string): Promise<any> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const { OpencodeAI } = await import('@tarquinen/opencode-auth-provider');
            return new OpencodeAI({ workspaceDir });
        } catch (error: any) {
            lastError = error;

            if (error.message?.includes('before initialization')) {
                logger?.debug(`Import attempt ${attempt}/${maxRetries} failed, will retry`, {
                    error: error.message
                });

                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
                    continue;
                }
            }

            throw error;
        }
    }

    throw lastError;
}

export async function selectModel(
    currentModel?: ModelInfo,
    logger?: Logger,
    configModel?: string,
    workspaceDir?: string
): Promise<ModelSelectionResult> {
    const opencodeAI = await importOpencodeAI(logger, 3, 100, workspaceDir);

    let failedModelInfo: ModelInfo | undefined;

    if (configModel) {
        const parts = configModel.split('/');
        if (parts.length !== 2) {
            logger?.warn('Invalid config model format', { configModel });
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
                logger?.warn(`Config model failed: ${providerID}/${modelID}`, {
                    error: error.message
                });
                failedModelInfo = { providerID, modelID };
            }
        }
    }

    if (currentModel) {
        if (shouldSkipProvider(currentModel.providerID)) {
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

export function extractModelFromSession(sessionState: any, logger?: Logger): ModelInfo | undefined {
    if (sessionState?.model?.providerID && sessionState?.model?.modelID) {
        return {
            providerID: sessionState.model.providerID,
            modelID: sessionState.model.modelID
        };
    }

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
