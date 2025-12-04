# OpenAI API Format

OpenAI offers two API formats: **Chat Completions** (original) and **Responses** (newer).

## Sources

- **AI SDK**: `packages/openai/src/chat/openai-chat-language-model.ts`, `packages/openai/src/responses/openai-responses-language-model.ts`
- **AI SDK OpenAI-Compatible**: `packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts`
- **Official Docs**: https://platform.openai.com/docs/api-reference/chat
- **Responses API**: https://platform.openai.com/docs/api-reference/responses

## Chat Completions API (`/chat/completions`)

### Request Structure

```json
{
  "model": "gpt-4o",
  "messages": [...],
  "tools": [...],
  "tool_choice": "auto" | "none" | "required" | {"type": "function", "function": {"name": "..."}},
  "max_tokens": 4096,
  "temperature": 0.7,
  "response_format": {"type": "json_object"} | {"type": "json_schema", "json_schema": {...}},
  "stream": false
}
```

### Message Roles

| Role | Description |
|------|-------------|
| `system` | System instructions |
| `user` | User input |
| `assistant` | Model responses |
| `tool` | Tool/function results |

### Message Formats

**System Message:**
```json
{"role": "system", "content": "You are a helpful assistant."}
```

**User Message (multimodal):**
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What's in this image?"},
    {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg", "detail": "auto"}},
    {"type": "file", "file": {"file_id": "file-abc123"}}
  ]
}
```

**Assistant Message with Tool Calls:**
```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"location\": \"San Francisco\"}"
      }
    }
  ]
}
```

**Tool Result Message:**
```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"temperature\": 72, \"condition\": \"sunny\"}"
}
```

### Tool Definition

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get the current weather",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {"type": "string"}
      },
      "required": ["location"]
    },
    "strict": true
  }
}
```

---

## Responses API (`/responses`)

### Key Differences from Chat Completions

| Feature | Chat Completions | Responses API |
|---------|-----------------|---------------|
| Message array | `messages` | `input` |
| Tool call ID field | `tool_call_id` | `call_id` |
| System message | In messages | `instructions` field or in input |
| Token limit | `max_tokens` | `max_output_tokens` |
| Reasoning | Not supported | `reasoning` config |

### Request Structure

```json
{
  "model": "gpt-4o",
  "input": [...],
  "instructions": "Optional system instructions",
  "tools": [...],
  "tool_choice": "auto" | "none" | "required" | {"type": "function", "name": "..."},
  "max_output_tokens": 4096,
  "previous_response_id": "resp_abc123",
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "stream": false
}
```

## Thinking/Reasoning (Responses API only)

### Request Configuration
```json
{
  "reasoning": {
    "effort": "low" | "medium" | "high",
    "summary": "auto" | "concise" | "detailed"
  }
}
```

**Parameters:**
- `effort`: How much reasoning effort (affects token usage)
- `summary`: How to summarize reasoning in response

**Constraints when reasoning enabled:**
- `temperature` is **NOT supported** (use default)
- `topP` is **NOT supported**
- Only available on reasoning models (o1, o3, etc.)

### Response Output Items

**Reasoning Item** (in output array):
```json
{
  "type": "reasoning",
  "id": "reasoning_abc123",
  "encrypted_content": "encrypted_base64_reasoning_content",
  "summary": [
    {"type": "summary_text", "text": "I analyzed the problem by..."}
  ]
}
```

**Key fields:**
- `encrypted_content`: The actual reasoning is encrypted/hidden
- `summary`: Optional human-readable summary of reasoning

### Usage Tracking
```json
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 200,
    "output_tokens_details": {
      "reasoning_tokens": 150
    }
  }
}
```

### SDK Conversion
The AI SDK handles reasoning items:
```typescript
// OpenAI Responses output
{type: "reasoning", id: "...", encrypted_content: "...", summary: [...]}

// Kept as reasoning type in SDK
{type: "reasoning", reasoningId: "...", text: "summary text"}
```

### Context Pruning for Reasoning
- **Encrypted content** cannot be inspected or modified
- **Summaries** provide readable insight into reasoning
- Reasoning items appear as separate items in `output` array
- `reasoning_tokens` in usage helps track cost

---

## Context Pruning Considerations

1. **Tool correlation**: Both formats use ID-based correlation (`tool_call_id` or `call_id`)
2. **Paired pruning**: Tool calls and their results should be pruned together
3. **Message roles**: 4 distinct roles in Chat Completions; Responses API uses item types
4. **Content types**: User content is `type: "text"/"image_url"` in Chat, `type: "input_text"/"input_image"` in Responses
5. **Assistant content**: String in Chat Completions, `output_text` array in Responses

## OpenAI-Compatible Providers

Most providers in models.dev use the OpenAI Chat Completions format via `@ai-sdk/openai-compatible`:
- together, deepseek, groq, fireworks, hyperbolic, novita, cerebras, sambanova, etc.

These providers accept the same request format but may have different:
- Supported models
- Rate limits
- Feature availability (vision, tool use, etc.)
