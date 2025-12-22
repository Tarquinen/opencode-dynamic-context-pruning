# Dynamic Context Pruning Plugin

[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by removing obsolete tool outputs from conversation history.

![DCP in action](dcp-demo3.png)

## Installation

Add to your OpenCode config:

```jsonc
// opencode.jsonc
{
    "plugin": ["@tarquinen/opencode-dcp@latest"],
}
```

Using `@latest` ensures you always get the newest version automatically when OpenCode starts.

Restart OpenCode. The plugin will automatically start optimizing your sessions.

## How Pruning Works

DCP uses multiple strategies to reduce context size:

**Deduplication** — Identifies repeated tool calls (e.g., reading the same file multiple times) and keeps only the most recent output. Runs automatically on every request with zero LLM cost.

**Supersede Writes** — Prunes write tool inputs for files that have subsequently been read. When a file is written and later read, the original write content becomes redundant since the current file state is captured in the read result. Runs automatically on every request with zero LLM cost.

**Discard Tool** — Exposes a `discard` tool that the AI can call to remove completed or noisy tool outputs from context. Use this for task completion cleanup and removing irrelevant outputs.

**Extract Tool** — Exposes an `extract` tool that the AI can call to distill valuable context into concise summaries before removing the raw outputs. Use this when you need to preserve key findings while reducing context size.

**On Idle Analysis** — Uses a language model to semantically analyze conversation context during idle periods and identify tool outputs that are no longer relevant.

Your session history is never modified. DCP replaces pruned outputs with a placeholder before sending requests to your LLM.

## Impact on Prompt Caching

LLM providers like Anthropic and OpenAI cache prompts based on exact prefix matching. When DCP prunes a tool output, it changes the message content, which invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache read benefits but gain larger token savings from reduced context size. In most cases, the token savings outweigh the cache miss cost—especially in long sessions where context bloat becomes significant.

## Configuration

DCP uses its own config file:

- Global: `~/.config/opencode/dcp.jsonc` (or `dcp.json`), created automatically on first run
- Custom config directory: `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`), if `OPENCODE_CONFIG_DIR` is set
- Project: `.opencode/dcp.jsonc` (or `dcp.json`) in your project’s `.opencode` directory

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    // Enable or disable the plugin
    "enabled": true,
    // Enable debug logging to ~/.config/opencode/logs/dcp/
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Protect from pruning for <turns> message turns
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // LLM-driven context pruning tools
    "tools": {
        // Shared settings for all prune tools
        "settings": {
            // Nudge the LLM to use prune tools (every <nudgeFrequency> tool results)
            "nudgeEnabled": true,
            "nudgeFrequency": 10,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Removes tool content from context without preservation (for completed tasks or noise)
        "discard": {
            "enabled": true,
        },
        // Distills key findings into preserved knowledge before removing raw content
        "extract": {
            "enabled": true,
            // Show distillation content as an ignored message notification
            "showDistillation": false,
        },
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Prune write tool inputs when the file has been subsequently read
        "supersedeWrites": {
            "enabled": true,
        },
        // (Legacy) Run an LLM to analyze what tool calls are no longer relevant on idle
        "onIdle": {
            "enabled": false,
            // Additional tools to protect from pruning
            "protectedTools": [],
            // Override model for analysis (format: "provider/model")
            // "model": "anthropic/claude-haiku-4-5",
            // Show toast notifications when model selection fails
            "showModelErrorToasts": true,
            // When true, fallback models are not permitted
            "strictModelSelection": false,
        },
    },
}
```

</details>

### Turn Protection

When enabled, turn protection prevents tool outputs from being pruned for a configurable number of message turns. This gives the AI time to reference recent tool outputs before they become prunable. Applies to both `discard` and `extract` tools, as well as automatic strategies.

### Protected Tools

By default, these tools are always protected from pruning across all strategies:
`task`, `todowrite`, `todoread`, `discard`, `extract`, `batch`

The `protectedTools` arrays in each section add to this default list:

- `tools.settings.protectedTools` — Protects tools from the `discard` and `extract` tools
- `strategies.deduplication.protectedTools` — Protects tools from deduplication
- `strategies.onIdle.protectedTools` — Protects tools from on-idle analysis

### Config Precedence

Settings are merged in order:
Defaults → Global (`~/.config/opencode/dcp.jsonc`) → Config Dir (`$OPENCODE_CONFIG_DIR/dcp.jsonc`) → Project (`.opencode/dcp.jsonc`).
Each level overrides the previous, so project settings take priority over config-dir and global, which take priority over defaults.

Restart OpenCode after making config changes.

## License

MIT
