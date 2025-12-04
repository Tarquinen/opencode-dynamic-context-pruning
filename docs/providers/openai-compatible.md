# OpenAI-Compatible Providers

Most providers in models.dev use the OpenAI Chat Completions format via `@ai-sdk/openai-compatible`. This document covers these providers and any provider-specific quirks.

## Standard OpenAI Chat Completions Format

See [openai.md](./openai.md) for the full format specification.

### Quick Reference

```json
{
  "model": "model-name",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "...", "tool_calls": [...]},
    {"role": "tool", "tool_call_id": "...", "content": "..."}
  ],
  "tools": [...],
  "tool_choice": "auto"
}
```

## Providers Using OpenAI-Compatible Format

Based on models.dev, these providers use `@ai-sdk/openai-compatible`:

| Provider | Base URL | Notes |
|----------|----------|-------|
| together | api.together.xyz | |
| deepseek | api.deepseek.com | |
| groq | api.groq.com | Very fast inference |
| fireworks | api.fireworks.ai | |
| hyperbolic | api.hyperbolic.xyz | |
| novita | api.novita.ai | |
| cerebras | api.cerebras.ai | |
| sambanova | api.sambanova.ai | |
| nebius | api.studio.nebius.ai | |
| chutes | api.chutes.ai | |
| openrouter | openrouter.ai | Meta-provider |
| kluster | api.kluster.ai | |
| glhf | glhf.chat | |
| scaleway | api.scaleway.ai | |
| lepton | api.lepton.ai | |
| nano-gpt | api.nano-gpt.com | |
| arcee | api.arcee.ai | |
| inference-net | api.inference.net | |
| nineteen | api.nineteen.ai | |
| targon | api.targon.ai | |
| req-ai | api.req.ai | |
| vllm | (self-hosted) | |
| ollama | localhost:11434 | Local models |
| lmstudio | localhost:1234 | Local models |
| jan | localhost:1337 | Local models |
| any-provider | (configurable) | Generic OpenAI-compatible |

## Provider-Specific Quirks

### OpenRouter
- Acts as a meta-provider routing to various backends
- May have different caching semantics
- Supports `cache_control` similar to Anthropic when routing to Claude

### Groq
- Extremely fast inference
- Limited model selection
- May have stricter rate limits

### DeepSeek
- Supports reasoning models (DeepSeek R1)
- May include thinking/reasoning in responses

### Ollama / LM Studio / Jan
- Local inference
- No rate limits but hardware-dependent
- May not support all features (vision, tools)

### Together AI
- Wide model selection
- Good tool support
- Supports streaming

## Caching Considerations

Some OpenAI-compatible providers support caching hints:

```json
{
  "role": "user",
  "content": "...",
  "cache_control": {"type": "ephemeral"}
}
```

Supported by:
- OpenRouter (when routing to Anthropic)
- Some enterprise deployments

## Vision Support

Not all OpenAI-compatible providers support vision. Check model capabilities:

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What's in this image?"},
    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
  ]
}
```

## Tool Support

Tool support varies by provider and model. Common limitations:
- Some models don't support parallel tool calls
- Some models don't support structured outputs/strict mode
- Response format (`json_object`) support varies

## Context Pruning Considerations

1. **Standard ID correlation**: All use `tool_call_id` for tool result correlation
2. **Consistent message format**: Messages follow OpenAI structure
3. **Feature detection**: May need to check model capabilities at runtime
4. **Cache support varies**: Not all providers honor cache hints
5. **Paired pruning**: Tool calls and results must be pruned together

## Detection

OpenAI-compatible requests can be detected by:
- `body.messages` array present
- Messages have `role` field with values: `system`, `user`, `assistant`, `tool`
- Tool results have `tool_call_id` field
- No special top-level fields like `contents` (Gemini) or `system` array (Bedrock/Anthropic)
