# AWS Bedrock API Format

AWS Bedrock uses the Converse API with unique content block types and caching via `cachePoint`.

## Sources

- **AI SDK**: `packages/amazon-bedrock/src/convert-to-bedrock-chat-messages.ts`, `packages/amazon-bedrock/src/bedrock-chat-language-model.ts`
- **OpenCode Transform**: `src/provider/transform.ts` (cachePoint insertion)
- **Official Docs**: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html

## Request Structure

```json
{
  "system": [
    {"text": "System message"},
    {"cachePoint": {"type": "default"}}
  ],
  "messages": [
    {"role": "user", "content": [...]},
    {"role": "assistant", "content": [...]}
  ],
  "inferenceConfig": {
    "maxTokens": 4096,
    "temperature": 0.7,
    "topP": 0.9,
    "topK": 50,
    "stopSequences": ["END"]
  },
  "toolConfig": {
    "tools": [...],
    "toolChoice": {"auto": {}}
  },
  "additionalModelRequestFields": {
    "thinking": {"type": "enabled", "budget_tokens": 10000}
  }
}
```

## Key Differences from OpenAI

| Feature | OpenAI | Bedrock |
|---------|--------|--------|
| System message | In messages | Top-level `system` array |
| Tool calls | `tool_calls` array | `toolUse` content block |
| Tool results | `role: "tool"` | `toolResult` in user content |
| Tool call ID | `tool_call_id` | `toolUseId` |
| Caching | Not available | `cachePoint` blocks |

## Message Roles

Only **two roles**: `user` and `assistant`. Tool results go in user messages.

## Content Block Types

### Text Block
```json
{"text": "Hello, how can I help?"}
```

### Image Block
```json
{
  "image": {
    "format": "jpeg",
    "source": {"bytes": "<base64-encoded-data>"}
  }
}
```
Formats: `jpeg`, `png`, `gif`, `webp`

### Document Block
```json
{
  "document": {
    "format": "pdf",
    "name": "document-1",
    "source": {"bytes": "<base64-encoded-data>"},
    "citations": {"enabled": true}
  }
}
```
Formats: `pdf`, `csv`, `doc`, `docx`, `xls`, `xlsx`, `html`, `txt`, `md`

### Tool Use Block (Assistant calling tool)
```json
{
  "toolUse": {
    "toolUseId": "tool_call_123",
    "name": "get_weather",
    "input": {"city": "Seattle"}
  }
}
```

### Tool Result Block (User providing result)
```json
{
  "toolResult": {
    "toolUseId": "tool_call_123",
    "content": [
      {"text": "Temperature: 72F"},
      {"image": {"format": "png", "source": {"bytes": "..."}}}
    ]
  }
}
```

### Reasoning Block (Anthropic models)
```json
{
  "reasoningContent": {
    "reasoningText": {
      "text": "Let me think through this...",
      "signature": "<signature-for-caching>"
    }
  }
}
```

## Thinking/Reasoning (Anthropic Models via Bedrock)

### Request Configuration
```json
{
  "additionalModelRequestFields": {
    "thinking": {
      "type": "enabled",
      "budget_tokens": 10000
    }
  }
}
```

**Note**: Bedrock uses `reasoningConfig` in the SDK which gets transformed to Anthropic's `thinking` format in `additionalModelRequestFields`.

**Parameters:**
- `type`: `"enabled"` or `"disabled"`
- `budget_tokens`: Token budget for thinking (minimum 1024)

### Response Content Blocks

**Reasoning Text Block** (visible reasoning):
```json
{
  "reasoningContent": {
    "reasoningText": {
      "text": "Let me analyze this step by step...",
      "signature": "cryptographic_signature_for_verification"
    }
  }
}
```

**Redacted Reasoning Block** (hidden reasoning):
```json
{
  "reasoningContent": {
    "redactedReasoning": {
      "data": "encrypted_base64_redacted_content"
    }
  }
}
```

### SDK Conversion
The AI SDK converts Bedrock's reasoning blocks to unified format:
```typescript
// Bedrock response
{reasoningContent: {reasoningText: {text: "...", signature: "..."}}}

// Converted to SDK format
{type: "reasoning", text: "...", signature: "..."}

// Redacted version
{reasoningContent: {redactedReasoning: {data: "..."}}}

// Converted to SDK format
{type: "redacted-reasoning", data: "..."}
```

### Context Pruning for Reasoning
- **Signatures are cryptographic** - preserve for verification
- **Redacted reasoning** contains encrypted content that cannot be inspected
- Reasoning blocks appear in assistant message content
- Consider reasoning as important but potentially large context

### Cache Point
```json
{"cachePoint": {"type": "default"}}
```

## Caching Mechanism

Cache points can be inserted at:
1. In system messages - After each system message
2. In user message content - After content blocks
3. In assistant message content - After content blocks
4. In tool configuration - After tool definitions

## Tool Definition

```json
{
  "tools": [
    {
      "toolSpec": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "inputSchema": {
          "json": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
          }
        }
      }
    },
    {"cachePoint": {"type": "default"}}
  ],
  "toolChoice": {"auto": {}}
}
```

### Tool Choice Options
- `{"auto": {}}` - Model decides
- `{"any": {}}` - Force tool use (maps to "required")
- `{"tool": {"name": "tool_name"}}` - Force specific tool

## Complete Example

```json
{
  "system": [
    {"text": "You are a helpful assistant."},
    {"cachePoint": {"type": "default"}}
  ],
  "messages": [
    {
      "role": "user",
      "content": [{"text": "What's the weather in Seattle?"}]
    },
    {
      "role": "assistant",
      "content": [{
        "toolUse": {
          "toolUseId": "call_001",
          "name": "get_weather",
          "input": {"city": "Seattle"}
        }
      }]
    },
    {
      "role": "user",
      "content": [
        {
          "toolResult": {
            "toolUseId": "call_001",
            "content": [{"text": "{\"temperature\": 72, \"condition\": \"sunny\"}"}]
          }
        },
        {"cachePoint": {"type": "default"}}
      ]
    }
  ],
  "toolConfig": {
    "tools": [{"toolSpec": {"name": "get_weather", "description": "Get weather", "inputSchema": {"json": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}}],
    "toolChoice": {"auto": {}}
  }
}
```

## Unique Behaviors

1. **Trailing whitespace trimming**: Last text block in assistant messages is trimmed
2. **Empty text blocks skipped**: Whitespace-only text blocks are filtered
3. **Temperature clamping**: Clamped to [0, 1] range
4. **Tool content filtering**: If no tools available, tool content is removed with warning

## Context Pruning Considerations

1. **Tool correlation**: Uses `toolUseId` for correlation
2. **Tool results in user messages**: `toolResult` blocks are in user message content
3. **Message grouping**: Consecutive same-role messages are merged
4. **Cache points**: Preserve `cachePoint` markers when beneficial
5. **Paired pruning**: `toolUse` and corresponding `toolResult` must be pruned together
6. **System first**: System messages must come before user/assistant messages
