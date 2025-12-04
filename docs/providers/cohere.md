# Cohere API Format

Cohere uses a chat-based API with unique features like built-in RAG via `documents` and citations.

## Request Structure

```json
{
  "model": "command-r-plus",
  "messages": [...],
  "max_tokens": 4096,
  "temperature": 0.7,
  "p": 0.9,
  "k": 40,
  "frequency_penalty": 0.0,
  "presence_penalty": 0.0,
  "seed": 12345,
  "stop_sequences": ["END"],
  "response_format": {"type": "json_object"},
  "tools": [...],
  "tool_choice": "REQUIRED",
  "documents": [...],
  "thinking": {"type": "enabled", "token_budget": 2048}
}
```

## Key Differences from OpenAI

| Feature | OpenAI | Cohere |
|---------|--------|-------|
| Top-p parameter | `top_p` | `p` |
| Top-k parameter | `top_k` | `k` |
| Tool choice required | `"required"` | `"REQUIRED"` (uppercase) |
| RAG | Not built-in | `documents` array |
| Citations | Not built-in | Automatic with documents |

## Message Formats

### System Message
```json
{"role": "system", "content": "You are a helpful assistant."}
```

### User Message (text only)
```json
{"role": "user", "content": "What is the weather today?"}
```
**Note**: Files/documents are extracted to top-level `documents` array for RAG.

### Assistant Message
```json
{
  "role": "assistant",
  "content": "The weather is sunny.",
  "tool_plan": undefined,
  "tool_calls": undefined
}
```

### Assistant Message with Tool Calls
```json
{
  "role": "assistant",
  "content": undefined,
  "tool_plan": undefined,
  "tool_calls": [{
    "id": "call_abc123",
    "type": "function",
    "function": {
      "name": "get_weather",
      "arguments": "{\"location\": \"San Francisco\"}"
    }
  }]
}
```
**Key quirk**: When `tool_calls` present, `content` is `undefined`.

### Tool Result Message
```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"temperature\": 72, \"conditions\": \"sunny\"}"
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
      }
    }
  }],
  "tool_choice": "REQUIRED"
}
```

### Tool Choice Values (UPPERCASE)
- `undefined` - Auto (model decides)
- `"NONE"` - Disable tool use
- `"REQUIRED"` - Force tool use

**Note**: To force a specific tool, filter `tools` array and set `tool_choice: "REQUIRED"`.

## RAG via Documents

```json
{
  "documents": [
    {
      "data": {
        "text": "Document content here",
        "title": "Optional Title"
      }
    }
  ]
}
```

## Response Structure

```json
{
  "generation_id": "abc-123",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Response here."},
      {"type": "thinking", "thinking": "Reasoning..."}
    ],
    "tool_plan": "I will call the API",
    "tool_calls": [...],
    "citations": [{
      "start": 0,
      "end": 10,
      "text": "cited text",
      "sources": [{"type": "document", "id": "doc1", "document": {...}}]
    }]
  },
  "finish_reason": "COMPLETE",
  "usage": {...}
}
```

**Note**: Response `content` is an **array** of typed objects (unlike request which uses string).

## Unique Features

1. **Thinking mode**: Native reasoning via `thinking` config, returns `{"type": "thinking"}` blocks
2. **Citations**: Automatic source citations when using `documents`
3. **Tool plan**: `tool_plan` field explains tool usage reasoning
4. **Null arguments**: May return `"null"` for parameterless tools (normalize to `"{}"`)

## Thinking/Reasoning

### Request Configuration
```json
{
  "thinking": {
    "type": "enabled",
    "token_budget": 2048
  }
}
```

**Parameters:**
- `type`: `"enabled"` or `"disabled"`
- `token_budget`: Token budget for thinking

### Response Content Blocks

**Thinking Block** (in response content array):
```json
{
  "type": "thinking",
  "thinking": "Let me reason through this problem..."
}
```

**Note**: Unlike Mistral, Cohere's `thinking` field is a **string**, not an array.

### Response Structure with Thinking
```json
{
  "message": {
    "role": "assistant",
    "content": [
      {"type": "thinking", "thinking": "First, I need to consider..."},
      {"type": "text", "text": "Based on my analysis..."}
    ]
  }
}
```

### Streaming Events for Thinking
```json
// content-start (thinking)
{"type": "content-start", "index": 0, "delta": {"message": {"content": {"type": "thinking", "thinking": ""}}}}

// content-delta (thinking)
{"type": "content-delta", "index": 0, "delta": {"message": {"content": {"thinking": "reasoning chunk..."}}}}
```

### SDK Conversion
The AI SDK converts Cohere's thinking blocks to unified format:
```typescript
// Cohere response content
{type: "thinking", thinking: "..."}

// Converted to SDK format
{type: "reasoning", text: "..."}
```

### Context Pruning for Thinking
- Thinking blocks appear in response `content` array
- No signatures or encryption - content is plaintext string
- Consider thinking as important context but potentially large
- Thinking appears before text content in the response

## Complete Example

```json
{
  "model": "command-r-plus",
  "messages": [
    {"role": "system", "content": "You are a weather assistant."},
    {"role": "user", "content": "Weather in Paris?"},
    {
      "role": "assistant",
      "content": undefined,
      "tool_plan": undefined,
      "tool_calls": [{
        "id": "call_001",
        "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"location\":\"Paris\"}"}
      }]
    },
    {
      "role": "tool",
      "tool_call_id": "call_001",
      "content": "{\"temperature\":18,\"conditions\":\"cloudy\"}"
    }
  ],
  "tools": [{
    "type": "function",
    "function": {"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}}
  }],
  "max_tokens": 1024,
  "temperature": 0.7
}
```

## Streaming Events

| Event | Purpose |
|-------|--------|
| `message-start` | Start of response |
| `content-start` | Start of text/thinking block |
| `content-delta` | Text or thinking chunk |
| `tool-plan-delta` | Tool planning reasoning |
| `tool-call-start` | Start of tool call |
| `tool-call-delta` | Tool call arguments chunk |
| `message-end` | Final with `finish_reason` and `usage` |

## Context Pruning Considerations

1. **Tool correlation**: Uses `tool_call_id` like OpenAI
2. **Separate tool results**: Each result is a separate message (not grouped)
3. **Content exclusivity**: When `tool_calls` present, `content` is `undefined`
4. **Response vs request format**: Response content is array, request is string
5. **Uppercase tool choice**: Use `"NONE"` and `"REQUIRED"` (not lowercase)
6. **Paired pruning**: Tool calls and results must be pruned together
7. **Documents top-level**: RAG documents are separate from messages
