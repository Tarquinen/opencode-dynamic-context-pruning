# Google Gemini API Format

Google's Generative AI (Gemini) uses a unique format with **position-based tool correlation** (no tool call IDs).

## Sources

- **AI SDK**: `packages/google/src/convert-to-google-generative-ai-messages.ts`, `packages/google/src/google-generative-ai-language-model.ts`
- **Schema Conversion**: `packages/google/src/convert-json-schema-to-openapi-schema.ts`
- **OpenCode Transform**: `src/provider/transform.ts` (schema integer→string enum conversion)
- **Official Docs**: https://ai.google.dev/api/rest/v1/models/generateContent

## Request Structure

```json
{
  "systemInstruction": {
    "parts": [{"text": "System prompt text"}]
  },
  "contents": [
    {"role": "user", "parts": [...]},
    {"role": "model", "parts": [...]}
  ],
  "generationConfig": {
    "maxOutputTokens": 1024,
    "temperature": 0.7,
    "topK": 40,
    "topP": 0.95,
    "responseMimeType": "application/json",
    "responseSchema": {...}
  },
  "tools": [...],
  "toolConfig": {
    "functionCallingConfig": {"mode": "AUTO"}
  }
}
```

## Key Differences from OpenAI

| Feature | OpenAI | Gemini |
|---------|--------|--------|
| Message container | `messages[]` | `contents[]` |
| System message | In messages | Top-level `systemInstruction` |
| Roles | system/user/assistant/tool | user/model only |
| Tool call IDs | ID-based correlation | **POSITION-BASED** |
| Tool results | Separate `tool` role | In `user` message as `functionResponse` |

## Message Roles

Only **two roles**: `user` and `model`

| SDK Role | Gemini Role |
|----------|-------------|
| `system` | `systemInstruction` (top-level) |
| `user` | `user` |
| `assistant` | `model` |
| `tool` (results) | `user` (with `functionResponse`) |

## Content Parts

### Text Part
```json
{"text": "Hello, how are you?"}
```

### Thinking Part
```json
{"text": "Let me think...", "thought": true, "thoughtSignature": "sig-for-caching"}
```

## Thinking/Reasoning

### Request Configuration
```json
{
  "generationConfig": {
    "thinkingConfig": {
      "thinkingBudget": 8192,
      "includeThoughts": true
    }
  }
}
```

**Parameters:**
- `thinkingBudget`: Token budget for thinking
- `includeThoughts`: Whether to include thinking in response (default true)

### Response Content Parts

**Thinking Part** (in model message):
```json
{
  "text": "Let me reason through this problem...",
  "thought": true,
  "thoughtSignature": "signature_for_caching"
}
```

**Key fields:**
- `thought: true` - Marks this part as reasoning content
- `thoughtSignature` - Optional signature for caching/verification

### Usage Tracking
```json
{
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 200,
    "thoughtsTokenCount": 150
  }
}
```

### SDK Conversion
The AI SDK converts Gemini's thought parts to unified `reasoning` type:
```typescript
// Gemini response part
{text: "...", thought: true, thoughtSignature: "..."}

// Converted to SDK format
{type: "reasoning", text: "...", signature: "..."}
```

### Context Pruning for Thinking
- **Thought parts are regular text parts** with `thought: true` flag
- **thoughtSignature** should be preserved if present (used for caching)
- Thinking parts appear in `model` role messages
- Consider thinking as important but potentially large context

## Image (inline base64)
```json
{"inlineData": {"mimeType": "image/jpeg", "data": "base64-encoded-data"}}
```

### Image (file URI)
```json
{"fileData": {"mimeType": "image/png", "fileUri": "gs://bucket/path/image.png"}}
```

### Function Call (tool invocation)
```json
{"functionCall": {"name": "get_weather", "args": {"location": "Tokyo"}}}
```

### Function Response (tool result)
```json
{"functionResponse": {"name": "get_weather", "response": {"name": "get_weather", "content": "{\"temp\": 22}"}}}
```

## CRITICAL: Position-Based Tool Correlation

**Gemini does NOT use tool call IDs.** Tool results are correlated by **position/order**.

### Tool Call (model message)
```json
{
  "role": "model",
  "parts": [
    {"functionCall": {"name": "get_weather", "args": {"location": "SF"}}},
    {"functionCall": {"name": "get_time", "args": {"timezone": "PST"}}}
  ]
}
```

### Tool Results (user message) - ORDER MUST MATCH
```json
{
  "role": "user",
  "parts": [
    {"functionResponse": {"name": "get_weather", "response": {"name": "get_weather", "content": "72F"}}},
    {"functionResponse": {"name": "get_time", "response": {"name": "get_time", "content": "2:30 PM"}}}
  ]
}
```

## Tool Definition

```json
{
  "tools": [{
    "functionDeclarations": [{
      "name": "get_weather",
      "description": "Get the current weather",
      "parameters": {
        "type": "object",
        "properties": {"location": {"type": "string"}},
        "required": ["location"]
      }
    }]
  }],
  "toolConfig": {
    "functionCallingConfig": {"mode": "AUTO"}
  }
}
```

### Tool Config Modes
- `AUTO` - Model decides
- `NONE` - Disable tools
- `ANY` - Force tool use
- `ANY` + `allowedFunctionNames` - Force specific tools

### Provider-Defined Tools
```json
{"googleSearch": {}},
{"urlContext": {}},
{"codeExecution": {}}
```

## Schema Conversion (JSON Schema to OpenAPI)

Gemini requires **OpenAPI 3.0 schema format**:

| JSON Schema | OpenAPI |
|-------------|---------|
| `const: value` | `enum: [value]` |
| `type: ["string", "null"]` | `anyOf` + `nullable: true` |

## Gemma Model Handling

For `gemma-*` models, system instructions are **prepended to first user message**:
```json
{
  "contents": [{
    "role": "user",
    "parts": [{"text": "System prompt\n\nActual user message"}]
  }]
}
```

## Complete Example

```json
{
  "systemInstruction": {"parts": [{"text": "You are a weather assistant."}]},
  "contents": [
    {"role": "user", "parts": [{"text": "Weather in Tokyo?"}]},
    {"role": "model", "parts": [{"functionCall": {"name": "get_weather", "args": {"location": "Tokyo"}}}]},
    {"role": "user", "parts": [{"functionResponse": {"name": "get_weather", "response": {"name": "get_weather", "content": "22C cloudy"}}}]},
    {"role": "model", "parts": [{"text": "Tokyo is 22C and cloudy."}]}
  ],
  "tools": [{"functionDeclarations": [{"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}}]}]
}
```

## Context Pruning Considerations

1. **POSITION-BASED CORRELATION**: Tool calls and results must be pruned TOGETHER and order preserved
2. **No IDs**: Cannot selectively prune individual tool results - entire pairs must go
3. **System separate**: `systemInstruction` is top-level, typically should NOT be pruned
4. **Alternation required**: Must maintain alternating `user`/`model` pattern
5. **Multi-part messages**: Each message can have multiple parts; prune entire messages, not parts
6. **Tool results are user role**: `functionResponse` parts are in `user` messages
7. **thoughtSignature**: Used for caching reasoning; preserve if present
