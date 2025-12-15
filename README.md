# Dynamic Context Pruning Plugin

[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by removing obsolete tool outputs from conversation history.

![DCP in action](dcp-demo3.png)

## Installation

Add to your OpenCode config:

```jsonc
// opencode.jsonc
{
  "plugin": ["@tarquinen/opencode-dcp@latest"]
}
```

Using `@latest` ensures you always get the newest version automatically when OpenCode starts.

Restart OpenCode. The plugin will automatically start optimizing your sessions.

## How Pruning Works

DCP uses multiple strategies to reduce context size:

**Deduplication** — Identifies repeated tool calls (e.g., reading the same file multiple times) and keeps only the most recent output. Runs automatically on every request with zero LLM cost.

**On Idle Analysis** — Uses a language model to semantically analyze conversation context during idle periods and identify tool outputs that are no longer relevant.

**Prune Tool** — Exposes a `prune` tool that the AI can call to manually trigger pruning when it determines context cleanup is needed.

*More strategies coming soon.*

Your session history is never modified. DCP replaces pruned outputs with a placeholder before sending requests to your LLM.

## Impact on Prompt Caching

LLM providers like Anthropic and OpenAI cache prompts based on exact prefix matching. When DCP prunes a tool output, it changes the message content, which invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache read benefits but gain larger token savings from reduced context size. In most cases, the token savings outweigh the cache miss cost—especially in long sessions where context bloat becomes significant.

## Configuration

DCP uses its own config file (`~/.config/opencode/dcp.jsonc` or `.opencode/dcp.jsonc`), created automatically on first run.

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
  // Enable or disable the plugin
  "enabled": true,
  // Enable debug logging to ~/.config/opencode/logs/dcp/
  "debug": false,
  // Show toast notifications when a new version is available
  "showUpdateToasts": true,
  // Summary display: "off", "minimal", or "detailed"
  "pruningSummary": "detailed",
  // Strategies for pruning tokens from chat history
  "strategies": {
    // Remove duplicate tool calls (same tool with same arguments)
    "deduplication": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": []
    },
    // Exposes a prune tool to your LLM to call when it determines pruning is necessary
    "pruneTool": {
      "enabled": true,
      // Additional tools to protect from pruning
      "protectedTools": [],
      // Nudge the LLM to use the prune tool (every <frequency> tool results)
      "nudge": {
        "enabled": true,
        "frequency": 10
      }
    },
    // (Legacy) Run an LLM to analyze what tool calls are no longer relevant on idle
    "onIdle": {
      "enabled": false,
      // Override model for analysis (format: "provider/model")
      // "model": "anthropic/claude-haiku-4-5",
      // Show toast notifications when model selection fails
      "showModelErrorToasts": true,
      // When true, fallback models are not permitted
      "strictModelSelection": false,
      // Additional tools to protect from pruning
      "protectedTools": []
    }
  }
}
```

</details>

### Protected Tools

By default, these tools are always protected from pruning across all strategies:
`task`, `todowrite`, `todoread`, `prune`, `batch`, `write`, `edit`

The `protectedTools` arrays in each strategy add to this default list.

### Config Precedence

Settings are merged in order: **Defaults** → **Global** (`~/.config/opencode/dcp.jsonc`) → **Project** (`.opencode/dcp.jsonc`). Each level overrides the previous, so project settings take priority over global, which takes priority over defaults.

Restart OpenCode after making config changes.

## License

MIT
