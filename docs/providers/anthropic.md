# Anthropic Messages API Format

Anthropic uses a distinct message format with unique features like cache control and extended thinking.

## Sources

- **AI SDK**: `packages/anthropic/src/convert-to-anthropic-messages-prompt.ts`, `packages/anthropic/src/anthropic-messages-language-model.ts`
- **OpenCode Transform**: `src/provider/transform.ts` (toolCallId sanitization, cache control)
- **Official Docs**: https://docs.anthropic.com/en/api/messages

## Request Structure

```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 4096,
  "temperature": 1.0,
  "stream": true,
  "system": [
    {"type": "text", "text": "System instructions", "cache_control": {"type": "ephemeral"}}
  ],
  "messages": [...],
  "tools": [...],
  "tool_choice": {"type": "auto"},
  "thinking": {"type": "enabled", "budget_tokens": 10000}
}
```

## Key Differences from OpenAI

| Feature | OpenAI | Anthropic |
|---------|--------|-----------|
| System message | In messages array | Top-level `system` array |
| Tool results | `role: "tool"` message | In `user` message with `type: "tool_result"` |
| Tool call ID field | `tool_call_id` | `tool_use_id` |
| Caching | Not available | `cache_control` on content blocks |

## Message Roles

Only **two roles**: `user` and `assistant`. Tool results are embedded in user messages.

## Message Formats

### System Message (top-level, not in messages)
```json
{
  "system": [
    {
      "type": "text",
      "text": "You are a helpful assistant.",
      "cache_control": {"type": "ephemeral"}
    }
  ]
}
```

### User Message
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Hello", "cache_control": {"type": "ephemeral"}},
    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "..."}},
    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "..."}, "title": "Doc"}
  ]
}
```

### Assistant Message with Tool Use
```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Let me check the weather."},
    {
      "type": "tool_use",
      "id": "toolu_01XYZ",
      "name": "get_weather",
      "input": {"location": "San Francisco"},
      "cache_control": {"type": "ephemeral"}
    }
  ]
}
```

### Tool Result (in user message)
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01XYZ",
      "content": "72°F and sunny",
      "is_error": false,
      "cache_control": {"type": "ephemeral"}
    }
  ]
}
```

## Thinking/Reasoning (Extended Thinking)

### Request Configuration
```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

**Parameters:**
- `type`: `"enabled"` or `"disabled"`
- `budget_tokens`: Token budget for thinking (minimum 1024)

**Constraints when thinking enabled:**
- `temperature`, `topK`, `topP` are **NOT supported** (ignored with warnings)
- `max_tokens` is automatically adjusted to include `budget_tokens`
- Minimum budget is 1,024 tokens

### Response Content Blocks

**Thinking Block** (visible reasoning):
```json
{
  "type": "thinking",
  "thinking": "Let me analyze this step by step...",
  "signature": "cryptographic_signature_for_verification"
}
```

**Redacted Thinking Block** (hidden reasoning):
```json
{
  "type": "redacted_thinking",
  "data": "encrypted_base64_redacted_content"
}
```

### Streaming Deltas
```json
{"type": "thinking_delta", "thinking": "reasoning chunk..."}
{"type": "signature_delta", "signature": "sig_chunk"}
```

### SDK Conversion
The AI SDK converts Anthropic's `thinking` blocks to a unified `reasoning` type:
```typescript
// Anthropic response
{type: "thinking", thinking: "...", signature: "..."}

// Converted to SDK format
{type: "reasoning", text: "...", signature: "..."}
```

### Context Pruning for Thinking
- **Cannot apply cache_control** to thinking or redacted_thinking blocks
- **Signatures are cryptographic** - preserve for verification if replaying
- **Redacted thinking** contains encrypted content that cannot be inspected
- Consider thinking blocks as important context but potentially large

## Tool Definition

```json
{
  "name": "get_weather",
  "description": "Get weather for a location",
  "input_schema": {
    "type": "object",
    "properties": {"location": {"type": "string"}},
    "required": ["location"]
  },
  "cache_control": {"type": "ephemeral"}
}
```

### Tool Choice Options
- `{"type": "auto"}` - Model decides
- `{"type": "any"}` - Force tool use
- `{"type": "tool", "name": "get_weather"}` - Force specific tool

## Cache Control

```json
{"type": "ephemeral", "ttl": "5m"}
```

**Limits**: Maximum **4 cache breakpoints** per request

**Applicable to**: system messages, user/assistant content parts, tool results, tool definitions

**NOT applicable to**: `thinking` blocks, `redacted_thinking` blocks

## Special Tool Types

**Server Tool Use** (provider-executed):
```json
{"type": "server_tool_use", "id": "...", "name": "web_search", "input": {...}}
```
Names: `web_fetch`, `web_search`, `code_execution`, `bash_code_execution`, `text_editor_code_execution`

**MCP Tool Use**:
```json
{"type": "mcp_tool_use", "id": "...", "name": "custom_tool", "server_name": "my-mcp-server", "input": {...}}
```

## Context Pruning Considerations

1. **Tool correlation**: Uses `tool_use_id` (not `tool_call_id`)
2. **Tool results in user messages**: Unlike OpenAI, tool results are `content` parts in user messages
3. **Message merging**: Consecutive user messages are merged; consecutive assistant messages are merged
4. **Cache breakpoints**: Preserve `cache_control` markers when possible (max 4)
5. **Thinking blocks**: Have signatures for verification; handle with care
6. **Paired pruning**: `tool_use` and corresponding `tool_result` must be pruned together
