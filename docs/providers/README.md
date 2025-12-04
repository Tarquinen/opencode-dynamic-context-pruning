# Provider API Formats Reference

This directory contains documentation for each AI provider's API format, designed to help the context pruning plugin implement provider-specific logic.

## Sources

All information in these docs was gathered from:

### Primary Sources

| Source | Location | Description |
|--------|----------|-------------|
| **Vercel AI SDK** | https://github.com/vercel/ai | Provider conversion logic in `packages/{provider}/src/` |
| **OpenCode Source** | `/packages/opencode/src/provider/` | Custom transforms and provider loading |
| **models.dev API** | https://models.dev/api.json | Authoritative provider list with npm packages |

### Key AI SDK Files

| Provider | Conversion File |
|----------|-----------------|
| OpenAI | `packages/openai/src/chat/openai-chat-language-model.ts`, `packages/openai/src/responses/openai-responses-language-model.ts` |
| OpenAI-Compatible | `packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts` |
| Anthropic | `packages/anthropic/src/convert-to-anthropic-messages-prompt.ts`, `packages/anthropic/src/anthropic-messages-language-model.ts` |
| Google | `packages/google/src/convert-to-google-generative-ai-messages.ts`, `packages/google/src/google-generative-ai-language-model.ts` |
| AWS Bedrock | `packages/amazon-bedrock/src/convert-to-bedrock-chat-messages.ts`, `packages/amazon-bedrock/src/bedrock-chat-language-model.ts` |
| Mistral | `packages/mistral/src/convert-to-mistral-chat-messages.ts`, `packages/mistral/src/mistral-chat-language-model.ts` |
| Cohere | `packages/cohere/src/convert-to-cohere-chat-prompt.ts`, `packages/cohere/src/cohere-chat-language-model.ts` |

### OpenCode Custom Transform Files

| File | Purpose |
|------|---------|
| `src/provider/transform.ts` | Provider-specific message normalization, caching hints, schema transforms |
| `src/provider/provider.ts` | Provider loading, custom loaders, SDK instantiation |
| `src/provider/models.ts` | Model database schema, models.dev integration |
| `src/session/message-v2.ts` | Internal message structure, `toModelMessage()` conversion |

### Official API Documentation

| Provider | Documentation URL |
|----------|-------------------|
| OpenAI | https://platform.openai.com/docs/api-reference |
| Anthropic | https://docs.anthropic.com/en/api |
| Google Gemini | https://ai.google.dev/api/rest |
| AWS Bedrock | https://docs.aws.amazon.com/bedrock/latest/APIReference/ |
| Mistral | https://docs.mistral.ai/api/ |
| Cohere | https://docs.cohere.com/reference/chat |

---

## Format Categories

Providers fall into several format categories based on their API structure:

### 1. OpenAI Chat Completions Format
**Most common format - used by ~60 providers**

Key identifiers:
- `body.messages[]` array
- Tool results: `role: "tool"`, `tool_call_id`
- System in messages array

Providers: openai, together, deepseek, groq, fireworks, hyperbolic, novita, cerebras, sambanova, perplexity, openrouter, and most others

### 2. OpenAI Responses Format (newer)
**Used by OpenAI GPT models via responses API**

Key identifiers:
- `body.input[]` array
- Tool results: `type: "function_call_output"`, `call_id`

Providers: openai (responses endpoint), azure (responses endpoint)

### 3. Anthropic Format
**Distinct format with cache control**

Key identifiers:
- `body.messages[]` but tool results in user messages
- Tool results: `type: "tool_result"`, `tool_use_id`
- Top-level `system` array
- `cache_control` support

Providers: anthropic

### 4. Google Gemini Format
**Position-based tool correlation**

Key identifiers:
- `body.contents[]` array
- Tool results: `functionResponse` parts (no IDs!)
- Roles: `user`/`model` only
- Top-level `systemInstruction`

Providers: google, google-vertex

### 5. AWS Bedrock Format
**Converse API with cache points**

Key identifiers:
- Top-level `system` array
- Tool results: `toolResult` blocks with `toolUseId`
- `cachePoint` blocks

Providers: amazon-bedrock

### 6. Mistral Format (OpenAI-like with quirks)
**Strict ID requirements**

Key identifiers:
- OpenAI-like but 9-char alphanumeric tool IDs required
- User content always array

Providers: mistral

### 7. Cohere Format
**RAG-native with citations**

Key identifiers:
- Uses `p`/`k` instead of `top_p`/`top_k`
- Uppercase tool choice values
- `documents` array for RAG

Providers: cohere

## Quick Reference: Thinking/Reasoning

| Format | Request Config | Response Structure | Encrypted? | Signature? |
|--------|---------------|-------------------|------------|------------|
| OpenAI Responses | `reasoning: {effort, summary}` | `{type: "reasoning", encrypted_content, summary}` | Yes | No |
| Anthropic | `thinking: {type, budget_tokens}` | `{type: "thinking", thinking, signature}` | Partial* | Yes |
| Google Gemini | `thinkingConfig: {thinkingBudget}` | `{text, thought: true, thoughtSignature}` | No | Optional |
| AWS Bedrock | `additionalModelRequestFields.thinking` | `{reasoningContent: {reasoningText/redactedReasoning}}` | Partial* | Yes |
| Mistral | N/A (model decides) | `{type: "thinking", thinking: [{type: "text", text}]}` | No | No |
| Cohere | `thinking: {type, token_budget}` | `{type: "thinking", thinking: "..."}` | No | No |

*Partial = has both visible (`thinking`/`reasoningText`) and redacted (`redacted_thinking`/`redactedReasoning`) variants

**Key differences:**
- **OpenAI**: Reasoning is always encrypted; only summary is readable
- **Anthropic/Bedrock**: Can have visible thinking with signature, or redacted thinking
- **Gemini**: Thinking is a text part with `thought: true` flag
- **Mistral**: Thinking is nested array of text parts
- **Cohere**: Thinking is plain string

**SDK normalization**: All formats are converted to `{type: "reasoning", text: "..."}` by the AI SDK

## Quick Reference: Tool Call ID Fields

| Format | Tool Call ID Field | Tool Result ID Field |
|--------|-------------------|---------------------|
| OpenAI Chat | `tool_calls[].id` | `tool_call_id` |
| OpenAI Responses | `call_id` | `call_id` |
| Anthropic | `tool_use.id` | `tool_use_id` |
| Gemini | **NONE (position-based)** | **NONE** |
| Bedrock | `toolUse.toolUseId` | `toolResult.toolUseId` |
| Mistral | `tool_calls[].id` (9-char) | `tool_call_id` |
| Cohere | `tool_calls[].id` | `tool_call_id` |

## Detection Strategy

To detect which format a request uses:

```typescript
function detectFormat(body: unknown): string {
  if (body.input && Array.isArray(body.input)) return 'openai-responses'
  if (body.contents && Array.isArray(body.contents)) return 'gemini'
  if (body.system && Array.isArray(body.system) && body.inferenceConfig) return 'bedrock'
  if (body.messages) {
    // Check first message structure for Anthropic vs OpenAI
    const msg = body.messages[0]
    if (msg?.content?.[0]?.type === 'tool_result') return 'anthropic'
    if (msg?.content?.[0]?.tool_use_id) return 'anthropic'
  }
  return 'openai-chat' // Default
}
```

## Files

- [openai.md](./openai.md) - OpenAI Chat Completions & Responses API
- [anthropic.md](./anthropic.md) - Anthropic Messages API
- [google-gemini.md](./google-gemini.md) - Google Generative AI (Gemini)
- [aws-bedrock.md](./aws-bedrock.md) - AWS Bedrock Converse API
- [mistral.md](./mistral.md) - Mistral API
- [cohere.md](./cohere.md) - Cohere Chat API
- [openai-compatible.md](./openai-compatible.md) - OpenAI-compatible providers

## Context Pruning Universal Rules

1. **Tool call/result pairing**: Always prune tool calls and their results together
2. **Message alternation**: Most APIs expect alternating user/assistant messages
3. **System preservation**: System messages typically should not be pruned
4. **ID correlation**: Maintain ID relationships when pruning (except Gemini which is position-based)
5. **Cache markers**: Consider preserving cache control markers when present

---

## Complete Provider List (models.dev)

Every provider from models.dev and its API format:

### OpenAI Chat Format (43 providers)
*Uses `@ai-sdk/openai-compatible` - standard OpenAI messages format*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `agentrouter` | AgentRouter | |
| `alibaba` | Alibaba | |
| `alibaba-cn` | Alibaba (China) | |
| `bailing` | Bailing | |
| `baseten` | Baseten | |
| `chutes` | Chutes | |
| `cortecs` | Cortecs | |
| `deepseek` | DeepSeek | Reasoning models (R1) |
| `fastrouter` | FastRouter | |
| `fireworks-ai` | Fireworks AI | |
| `github-copilot` | GitHub Copilot | |
| `github-models` | GitHub Models | |
| `huggingface` | Hugging Face | |
| `iflowcn` | iFlow | |
| `inception` | Inception | |
| `inference` | Inference | |
| `io-net` | IO.NET | |
| `llama` | Llama | |
| `lmstudio` | LMStudio | Local inference |
| `lucidquery` | LucidQuery AI | |
| `modelscope` | ModelScope | |
| `moonshotai` | Moonshot AI | |
| `moonshotai-cn` | Moonshot AI (China) | |
| `morph` | Morph | |
| `nebius` | Nebius Token Factory | |
| `nvidia` | Nvidia | |
| `opencode` | OpenCode Zen | |
| `openrouter` | OpenRouter | Meta-provider, cache support |
| `ovhcloud` | OVHcloud AI Endpoints | |
| `poe` | Poe | |
| `requesty` | Requesty | |
| `scaleway` | Scaleway | |
| `siliconflow` | SiliconFlow | |
| `submodel` | submodel | |
| `synthetic` | Synthetic | |
| `upstage` | Upstage | |
| `venice` | Venice AI | |
| `vultr` | Vultr | |
| `wandb` | Weights & Biases | |
| `zai` | Z.AI | |
| `zai-coding-plan` | Z.AI Coding Plan | |
| `zenmux` | ZenMux | |
| `zhipuai` | Zhipu AI | |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | |

### OpenAI Native Format (1 provider)
*Uses `@ai-sdk/openai` - supports both Chat Completions and Responses API*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `openai` | OpenAI | Responses API for GPT-4.1+ |

### Azure Format (2 providers)
*Uses `@ai-sdk/azure` - OpenAI format with Azure auth*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `azure` | Azure | Supports Responses API |
| `azure-cognitive-services` | Azure Cognitive Services | |

### Anthropic Format (4 providers)
*Uses `@ai-sdk/anthropic` - distinct message format with cache control*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `anthropic` | Anthropic | Native Anthropic API |
| `kimi-for-coding` | Kimi For Coding | Uses Anthropic format |
| `minimax` | MiniMax | Uses Anthropic format |
| `minimax-cn` | MiniMax (China) | Uses Anthropic format |

### Google Gemini Format (3 providers)
*Uses `@ai-sdk/google` or `@ai-sdk/google-vertex` - POSITION-BASED tool correlation*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `google` | Google | Native Gemini API |
| `google-vertex` | Vertex | Google Cloud Vertex AI |
| `google-vertex-anthropic` | Vertex (Anthropic) | Claude via Vertex |

### AWS Bedrock Format (1 provider)
*Uses `@ai-sdk/amazon-bedrock` - Converse API with cachePoint*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `amazon-bedrock` | Amazon Bedrock | Multi-model, cachePoint support |

### Mistral Format (1 provider)
*Uses `@ai-sdk/mistral` - requires 9-char alphanumeric tool IDs*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `mistral` | Mistral | Strict tool ID format |

### Cohere Format (1 provider)
*Uses `@ai-sdk/cohere` - RAG-native with citations*

| Provider ID | Name | Notes |
|-------------|------|-------|
| `cohere` | Cohere | Uses `p`/`k`, uppercase tool choice |

### Specialized SDK Providers (13 providers)
*Use provider-specific SDKs but follow OpenAI-like format*

| Provider ID | Name | SDK | Format |
|-------------|------|-----|--------|
| `cerebras` | Cerebras | `@ai-sdk/cerebras` | OpenAI-like |
| `deepinfra` | Deep Infra | `@ai-sdk/deepinfra` | OpenAI-like |
| `groq` | Groq | `@ai-sdk/groq` | OpenAI-like |
| `perplexity` | Perplexity | `@ai-sdk/perplexity` | OpenAI-like |
| `togetherai` | Together AI | `@ai-sdk/togetherai` | OpenAI-like |
| `xai` | xAI | `@ai-sdk/xai` | OpenAI-like |
| `vercel` | Vercel AI Gateway | `@ai-sdk/gateway` | OpenAI-like |
| `v0` | v0 | `@ai-sdk/vercel` | OpenAI-like |
| `cloudflare-workers-ai` | Cloudflare Workers AI | `workers-ai-provider` | OpenAI-like |
| `ollama-cloud` | Ollama Cloud | `ai-sdk-ollama` | OpenAI-like |
| `aihubmix` | AIHubMix | `@aihubmix/ai-sdk-provider` | OpenAI-like |
| `sap-ai-core` | SAP AI Core | `@mymediset/sap-ai-provider` | OpenAI-like |

---

## Format Summary

| Format | Provider Count | Tool ID Field | Key Identifier |
|--------|---------------|---------------|----------------|
| OpenAI Chat | 56 | `tool_call_id` | `body.messages[]` |
| OpenAI Responses | 2 | `call_id` | `body.input[]` |
| Anthropic | 4 | `tool_use_id` | `tool_result` in user msg |
| Google Gemini | 3 | **NONE** | `body.contents[]` |
| AWS Bedrock | 1 | `toolUseId` | `body.inferenceConfig` |
| Mistral | 1 | `tool_call_id` (9-char) | Check provider ID |
| Cohere | 1 | `tool_call_id` | Check provider ID |

**Total: 69 providers**
