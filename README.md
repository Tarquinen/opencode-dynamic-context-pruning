# Dynamic Context Pruning Plugin

[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by removing obsolete tool outputs from conversation history.

## What It Does

This plugin automatically optimizes token usage by identifying and removing redundant or obsolete tool outputs from your conversation history.

![DCP in action](dcp-demo.png)

## Installation

Add to your OpenCode configuration:

**Global:** `~/.config/opencode/opencode.json`  
**Project:** `.opencode/opencode.json`

```json
{
  "plugin": [
    "@tarquinen/opencode-dcp"
  ]
}
```

> **Note:** OpenCode's `plugin` arrays are not merged between global and project configs—project config completely overrides global. If you have plugins in your global config and add a project config, include all desired plugins in the project config.

Restart OpenCode. The plugin will automatically start optimizing your sessions.

## Configuration

DCP uses its own configuration file, separate from OpenCode's `opencode.json`:

- **Global:** `~/.config/opencode/dcp.jsonc`
- **Project:** `.opencode/dcp.jsonc`

The global config is automatically created on first run. Create a project config to override settings per-project.

### Available Options

- **`enabled`** (boolean, default: `true`) - Enable/disable the plugin
- **`debug`** (boolean, default: `false`) - Enable detailed logging to `~/.config/opencode/logs/dcp/`
- **`model`** (string, optional) - Specific model for analysis (e.g., `"anthropic/claude-haiku-4-5"`). Uses session model or smart fallbacks when not specified.
- **`showModelErrorToasts`** (boolean, default: `true`) - Show notifications when model selection falls back
- **`pruningMode`** (string, default: `"smart"`) - Pruning strategy:
  - `"auto"`: Fast duplicate removal only (zero LLM cost)
  - `"smart"`: Deduplication + AI analysis (recommended, maximum savings)
- **`pruning_summary`** (string, default: `"detailed"`) - UI summary display mode:
  - `"off"`: No UI summary (silent pruning)
  - `"minimal"`: Show tokens saved and count only (e.g., "Saved ~2.5K tokens (6 tools pruned)")
  - `"detailed"`: Show full breakdown by tool type and pruning method
- **`protectedTools`** (string[], default: `["task", "todowrite", "todoread"]`) - Tools that should never be pruned

Example configuration:

```jsonc
{
  "enabled": true,
  "debug": false,
  "pruningMode": "smart",
  "pruning_summary": "detailed",
  "protectedTools": ["task", "todowrite", "todoread"]
}
```

### Configuration Hierarchy

Settings are merged in order: **Built-in defaults** → **Global config** → **Project config**

After modifying configuration, restart OpenCode for changes to take effect.

### Version Pinning

If you want to ensure a specific version is always used or update your version, you can pin it in your config:

```json
{
  "plugin": [
    "@tarquinen/opencode-dcp@0.3.12"
  ]
}
```

## License

MIT
