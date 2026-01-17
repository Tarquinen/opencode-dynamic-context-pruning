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

> **Note:** If you use OAuth plugins (e.g., for Google or other services), place this plugin last in your `plugin` array to avoid interfering with their authentication flows.

Restart OpenCode. The plugin will automatically start optimizing your sessions.

## How Pruning Works

DCP uses multiple tools and strategies to reduce context size:

### Tools

**Discard** — Exposes a `discard` tool that the AI can call to remove completed or noisy tool content from context.

**Extract** — Exposes an `extract` tool that the AI can call to distill valuable context into concise summaries before removing the tool content.

### Strategies

**Deduplication** — Identifies repeated tool calls (e.g., reading the same file multiple times) and keeps only the most recent output. Runs automatically on every request with zero LLM cost.

**Supersede Writes** — Prunes write tool inputs for files that have subsequently been read. When a file is written and later read, the original write content becomes redundant since the current file state is captured in the read result. Runs automatically on every request with zero LLM cost.

**Purge Errors** — Prunes tool inputs for tools that returned errors after a configurable number of turns (default: 4). Error messages are preserved for context, but the potentially large input content is removed. Runs automatically on every request with zero LLM cost.

Your session history is never modified—DCP replaces pruned content with placeholders before sending requests to your LLM.

### Preemptive Compaction (Experimental)

**Preemptive Compaction** — An optional multi-phase context reduction system that proactively manages context before it exceeds model limits. When enabled, it monitors token usage after each message and triggers compaction when usage exceeds a configurable threshold (default: 85%).

The compaction flow proceeds in phases:
1. **DCP Strategies** — Runs all enabled DCP strategies (deduplication, supersede writes, purge errors)
2. **Tool Truncation** — If still over threshold, truncates large tool outputs (preserving recent messages)
3. **Summarization** — If still over threshold, triggers OpenCode's built-in summarization

This prevents context overflow errors and maintains session continuity during long conversations. Disabled by default—enable via `preemptiveCompaction.enabled: true`.

## Impact on Prompt Caching

LLM providers like Anthropic and OpenAI cache prompts based on exact prefix matching. When DCP prunes a tool output, it changes the message content, which invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache read benefits but gain larger token savings from reduced context size and performance improvements through reduced context poisoning. In most cases, the token savings outweigh the cache miss cost—especially in long sessions where context bloat becomes significant.

**Best use case:** Providers that count usage in requests, such as Github Copilot and Google Antigravity have no negative price impact.

## Configuration

DCP uses its own config file:

- Global: `~/.config/opencode/dcp.jsonc` (or `dcp.json`), created automatically on first run
- Custom config directory: `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`), if `OPENCODE_CONFIG_DIR` is set
- Project: `.opencode/dcp.jsonc` (or `dcp.json`) in your project’s `.opencode` directory

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
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
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
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
            "enabled": false,
        },
        // Prune tool inputs for errored tools after X turns
        "purgeErrors": {
            "enabled": true,
            // Number of turns before errored tool inputs are pruned
            "turns": 4,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
    },
    // Preemptive compaction (experimental) - proactively manages context before limits
    "preemptiveCompaction": {
        // Disabled by default - opt-in feature
        "enabled": false,
        // Context usage threshold to trigger compaction (0.0 - 1.0)
        "threshold": 0.85,
        // Cooldown between compaction attempts (ms)
        "cooldownMs": 60000,
        // Minimum tokens before compaction can trigger
        "minTokens": 50000,
        // Tool output truncation settings
        "truncation": {
            "enabled": true,
            // Number of recent messages to protect from truncation
            "protectedMessages": 3,
        },
    },
}
```

</details>

### Turn Protection

When enabled, turn protection prevents tool outputs from being pruned for a configurable number of message turns. This gives the AI time to reference recent tool outputs before they become prunable. Applies to both `discard` and `extract` tools, as well as automatic strategies.

### Protected Tools

By default, these tools are always protected from pruning across all strategies:
`task`, `todowrite`, `todoread`, `discard`, `extract`, `batch`, `write`, `edit`

The `protectedTools` arrays in each section add to this default list.

### Config Precedence

Settings are merged in order:
Defaults → Global (`~/.config/opencode/dcp.jsonc`) → Config Dir (`$OPENCODE_CONFIG_DIR/dcp.jsonc`) → Project (`.opencode/dcp.jsonc`).
Each level overrides the previous, so project settings take priority over config-dir and global, which take priority over defaults.

Restart OpenCode after making config changes.

## Limitations

**Subagents** — DCP is disabled for subagents. Subagents are not designed to be token efficient; what matters is that the final message returned to the main agent is a concise summary of findings. DCP's pruning could interfere with this summarization behavior.

## License

MIT
