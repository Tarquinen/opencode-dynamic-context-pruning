# Mistral API Format

Mistral uses an OpenAI-compatible format but with **strict tool call ID requirements**.

## Sources

- **AI SDK**: `packages/mistral/src/convert-to-mistral-chat-messages.ts`, `packages/mistral/src/mistral-chat-language-model.ts`
- **OpenCode Transform**: `src/provider/transform.ts` (9-char alphanumeric ID normalization)
- **Official Docs**: https://docs.mistral.ai/api/#tag/chat

## Request Structure

```json
{
  "model": "mistral-large-latest",
  "messages": [...],
  "max_tokens": 4096,
  "temperature": 0.7,
  "top_p": 1.0,
  "random_seed": 42,
  "safe_prompt": false,
  "stream": false,
  "response_format": {"type": "json_object"},
  "tools": [...],
  "tool_choice": "auto"
}
```

## CRITICAL: Tool Call ID Requirement

**Mistral requires tool call IDs to be exactly 9 alphanumeric characters.**

| Valid | Invalid |
|-------|--------|
| `abc123xyz` | `call_abc123` (too long, has underscore) |
| `A1B2C3D4E` | `12345` (too short) |
| `def456uvw` | `abc-123-xy` (has hyphens) |

## Key Differences from OpenAI

| Feature | OpenAI | Mistral |
|---------|--------|--------|
| Tool call ID format | `call_*` (variable) | **Exactly 9 alphanumeric** |
| Tool choice `required` | `"required"` | `"any"` |
| User content | String or array | **Always array** |
| Assistant `prefix` | Not supported | Supported |
| Stop sequences | Supported | Not supported |
| Frequency/presence penalty | Supported | Not supported |

## Message Formats

### System Message
```json
{"role": "system", "content": "You are a helpful assistant."}
```

### User Message (always array)
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What's in this image?"},
    {"type": "image_url", "image_url": "https://example.com/image.jpg"},
    {"type": "document_url", "document_url": "data:application/pdf;base64,..."}
  ]
}
```

### Assistant Message
```json
{
  "role": "assistant",
  "content": "Here's the analysis...",
  "prefix": true,
  "tool_calls": [
    {
      "id": "abc123xyz",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"location\":\"San Francisco\"}"
      }
    }
  ]
}
```

### Tool Result Message
```json
{
  "role": "tool",
  "name": "get_weather",
  "tool_call_id": "abc123xyz",
  "content": "{\"temperature\": 72, \"condition\": \"sunny\"}"
}
```

## Tool Definition

```json
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get weather for a location",
      "parameters": {
        "type": "object",
        "properties": {"location": {"type": "string"}},
        "required": ["location"]
      },
      "strict": true
    }
  }],
  "tool_choice": "auto"
}
```

### Tool Choice Options
- `"auto"` - Model decides
- `"none"` - Disable tool calling
- `"any"` - Force tool use (NOT `"required"`)
- `{"type": "function", "function": {"name": "..."}}` - Force specific tool

## Unique Features

1. **Prefix flag**: `prefix: true` on assistant messages for continuation mode
2. **PDF support**: Via `document_url` content type with base64
3. **Thinking mode**: Returns `{"type": "thinking", "thinking": [...]}` content blocks

## Thinking/Reasoning (Magistral Models)

### Response Content Structure

Mistral's reasoning models (Magistral) return thinking in the response content:

**Thinking Block** (in assistant message content):
```json
{
  "type": "thinking",
  "thinking": [
    {"type": "text", "text": "Let me reason through this..."}
  ]
}
```

**Note**: The `thinking` field is an **array** of text parts, not a string.

### Streaming Response
When streaming, content can be a string OR array:
```json
{
  "choices": [{
    "delta": {
      "role": "assistant",
      "content": [
        {"type": "thinking", "thinking": [{"type": "text", "text": "reasoning..."}]},
        {"type": "text", "text": "final response"}
      ]
    }
  }]
}
```

### SDK Conversion
The AI SDK extracts and converts Mistral's thinking blocks:
```typescript
// Mistral response content
{type: "thinking", thinking: [{type: "text", text: "..."}]}

// Converted to SDK format
{type: "reasoning", text: "..."}
```

### Context Pruning for Thinking
- Thinking blocks appear as content items in assistant messages
- The nested `thinking` array contains text parts to concatenate
- No signatures or encryption - content is plaintext
- Consider thinking as important context but potentially large

## Complete Example

```json
{
  "model": "mistral-large-latest",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": [{"type": "text", "text": "Weather in NYC?"}]},
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [{
        "id": "abc123xyz",
        "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"location\":\"New York City\"}"}
      }]
    },
    {
      "role": "tool",
      "name": "get_weather",
      "tool_call_id": "abc123xyz",
      "content": "{\"temperature\":72,\"condition\":\"sunny\"}"
    }
  ],
  "tools": [{
    "type": "function",
    "function": {"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}}
  }],
  "tool_choice": "auto"
}
```

## Unsupported Features

- `topK`
- `frequencyPenalty`
- `presencePenalty`
- `stopSequences`

## Context Pruning Considerations

1. **9-char alphanumeric IDs**: When generating synthetic tool calls, IDs must be exactly 9 alphanumeric chars
2. **Tool correlation**: Uses `tool_call_id` like OpenAI
3. **User content always array**: Even single text becomes `[{"type": "text", "text": "..."}]`
4. **Tool name in result**: Tool result includes `name` field alongside `tool_call_id`
5. **Paired pruning**: Tool calls and results must be pruned together
