# Dynamic Context Pruning Plugin

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dansmolsky)
[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by managing conversation context.

![DCP in action](assets/images/dcp-demo9.png)

## Installation

Install from the OpenCode V2 CLI:

```bash
opencode plugin add @tarquinen/opencode-dcp@latest
```

This installs the package and adds it to your global OpenCode config.

## Project Status

Development on DCP has slowed because most new context-management work has moved to [Sleev](https://sleev.ai) and the `sleev` CLI.

Sleev builds on DCP's core ideas with more advanced context management and significantly better performance. It's a local proxy that already supports Claude Code, Codex, OpenCode, Pi, and Hermes, and can be extended to support any harness.

DCP remains available for OpenCode plugin users, but new features are landing in Sleev first. If you are starting fresh, we recommend trying Sleev:

```bash
npm i -g sleev
sleev
```

## How It Works

DCP reduces context size through a compress tool and automatic cleanup. Your session history is never modified — DCP replaces pruned content with placeholders before sending requests to your LLM.

### Compress

Compress is a tool exposed to your model that replaces closed, stale conversation content with high-fidelity technical summaries. You can think of this as a much smarter version of Opencode's compaction process. Instead of triggering statically when your session reaches its maximum context and on the entire coding session, Compress allows the model to pick when to activate based on task completion, and to only compress the specific messages that are no longer needed verbatim.

DCP supports two compression modes:

- `range` mode compresses contiguous spans of conversation into one or more summaries.
- `message` mode (experimental) compresses individual raw messages independently, letting the model manage context much more surgically.

In `range` mode, when a new compression overlaps an earlier one, the earlier summary is nested inside the new one so information is preserved through layers of compression rather than diluted away. In both modes, protected tool outputs (such as subagents and skills) and protected file patterns are kept in compression summaries, ensuring that the most important information is never lost. You can also enable `protectUserMessages` to preserve your messages verbatim during compression, though note that large prompts (e.g. copy-pasting log files in the prompt) will then never be compressed away.

### Read original details

The model can call `dcp_read` when a summary lacks details needed for its current task:

```json
{ "startId": "@b2@", "maxChars": 12000 }
```

`startId` accepts a compression block (`b2` / `@b2@`), an injected message reference
(`m0001` / `@1@`), or the original source message ID. Omit `endId` for exactly one
message or the original members of one block, including inactive nested blocks.
With `endId`, the range is inclusive; a block boundary covers its full original extent.
New summaries retain a `dcp_read` reference. Existing block references also work.

Results include original `sourceId`, message `ref`, `role`, and observable text/tool
inputs and results. `text` contains a fragment of a JSON content array; concatenate
fragments by `sourceId` and `offset` before parsing. `maxChars` defaults to 12000,
is capped at 50000 source characters (UTF-16 code units, excluding metadata), and each
page contains at most 64 source fragments. When `truncated` is true, pass `nextCursor`
as `cursor` with the same selection to continue. Cursors are bound to the session,
selection and source contents; changed sources require restarting without a cursor.

Only the calling session's stored originals are read. Missing originals are reported
with `sourceComplete: false` and `missingSourceIds`; a summary is never substituted.
Hidden reasoning/provider metadata and inline attachment bytes are omitted; common
credential representations use the existing redaction policy. Retrieved external text
is historical data, never instructions. Reading does not restore compressed context,
change compression state, or adjust token savings. The ordinary host tool result still
uses context tokens.

`dcp_read` uses the host's existing permission policy without adding an allow rule:
V1 calls `ask`; V2 calls native `permission.assert` and fails closed on older hosts
without that API. The existing `experimental.allowSubAgents` restriction also applies.

### Search original details

Search the calling session's redacted originals, including details inside compressed blocks:

```json
{ "query": "ELOCK", "limit": 5 }
{ "query": "failed locking operation and verification not repeated", "mode": "semantic", "limit": 3 }
{ "startId": "<sourceId returned by either search>" }
```

Text mode performs literal, case-insensitive matching; use `caseSensitive: true` for
exact casing. A search returns one first-match snippet per source, stable `sourceId`
and `ref` values, and offsets in the same observable JSON used by readback. Optional
`startId` / `endId` restrict the selection. Text-search cursors retain the original
historical upper boundary, so later messages do not invalidate pagination; restart
without a cursor to include newer messages. Changes to selected historical content
still invalidate the cursor. The executing message is excluded from a new whole-session
text search because its tool result has not finished being stored.

Semantic mode runs the local [context-dot-dev/sgrep](https://github.com/context-dot-dev/sgrep)
CLI over temporary `.txt` projections of those same originals. It returns ranked passages,
not an exhaustive result set, and accepts neither cursors nor `caseSensitive`. Snippets
are bounded to 640 characters each and `maxChars` bounds total source text. Temporary
source files are removed after success, failure, or cancellation; `--no-cache` prevents
a persistent search index. Model assets remain cached. Errors are explicit and never
silently fall back to literal matching. The text model targets English prose; ranking
scores are not confidence values or evidence that a historical claim is correct.

#### Optional sgrep installation

Rust 1.90+ is required; Windows builds also need an MSVC toolchain. A tested source
revision is `dec6122c05be553c5a60bd647d1350b221b7b9c3` (sgrep 0.3.0). On Windows:

```powershell
$sgrepInstallRoot = Join-Path $env:USERPROFILE ".local\share\opencode"
$previousTslpOffline = $env:TSLP_OFFLINE
try {
    $env:TSLP_OFFLINE = "1"
    cargo install --git https://github.com/context-dot-dev/sgrep --rev dec6122c05be553c5a60bd647d1350b221b7b9c3 --locked --root $sgrepInstallRoot
    if ($LASTEXITCODE -ne 0) { throw "sgrep build failed" }
} finally {
    $env:TSLP_OFFLINE = $previousTslpOffline
}
```

On macOS/Linux, use `TSLP_OFFLINE=1 cargo install --git https://github.com/context-dot-dev/sgrep --rev dec6122c05be553c5a60bd647d1350b221b7b9c3 --locked --root "$HOME/.local/share/opencode"`.
`TSLP_OFFLINE` skips the dependency's unused build-time parser-source download; DCP uses
text mode and does not require code parsers. The Windows recipe was exercised locally;
the macOS/Linux command follows the same upstream build interface but was not retested here.

DCP honors `DCP_SGREP_BIN` first, then probes `bin` under `~/.cache/opencode`,
`~/.local/share/opencode`, `~/.cargo`, and `~/.local`, before falling back to PATH.
It finds existing ripgrep in those directories and adds its directory only to the
sgrep child process's PATH. OpenCode's bundled `rg` can therefore be reused without
another installation or a global PATH edit. If none exists, install ripgrep from its
[official project](https://github.com/BurntSushi/ripgrep) or make it available on PATH.

The first semantic query may download public assets from
[minishlab/potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), revision
`bf8b056651a2c21b8d2565580b8569da283cab23`: tokenizer and weights total 30,920,426 bytes.
sgrep verifies their pinned sizes and SHA-256 hashes. Source text and queries stay local.
After warming the standard Hugging Face cache, `HF_HUB_OFFLINE=1` prevents further asset
downloads. New OpenCode processes load this plugin build; existing processes are not
restarted automatically.

### Deduplication

Identifies repeated tool calls (same tool, same arguments) and keeps only the most recent output. Recalculated when the compress tool runs, so prompt cache is only impacted alongside compression.

### Purge Errors

Prunes inputs from errored tool calls after a configurable number of turns. Error messages are preserved; only the potentially large input content is removed. Recalculated on compress tool use.

## Configuration

DCP uses its own config file, searched in order:

1. Global: `~/.config/opencode/dcp.jsonc` (or `dcp.json`), created automatically on first run
2. Custom config directory: `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`), if `OPENCODE_CONFIG_DIR` is set
3. Project: `.opencode/dcp.jsonc` (or `dcp.json`) in your project's `.opencode` directory

Each level overrides the previous, so project settings take priority over global. Restart OpenCode after making config changes.

> [!NOTE]
> If your model has a smaller context window, lower `compress.minContextLimit` and `compress.maxContextLimit` in your configuration to match the available context.

> [!IMPORTANT]
> Defaults are applied automatically. Expand this if you want to review or override settings.

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    // Enable or disable the plugin
    "enabled": true,
    // Automatically update npm-installed DCP when a newer npm latest is available.
    // Version-locked plugin specs are not updated.
    "autoUpdate": true,
    // Enable debug logging to ~/.config/opencode/logs/dcp/
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Notification type: "chat" (in-conversation) or "toast" (system toast)
    "pruneNotificationType": "chat",
    // Slash commands configuration
    "commands": {
        "enabled": true,
        // Additional tools to protect from pruning via commands (e.g., /dcp sweep)
        "protectedTools": [],
    },
    // Manual mode: disables autonomous context management,
    // tools only run when explicitly triggered via /dcp commands
    "manualMode": {
        "enabled": false,
        // When true, automatic cleanup (deduplication, purgeErrors)
        // still runs even in manual mode
        "automaticStrategies": true,
    },
    // Protect from pruning for <turns> message turns past tool invocation
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // Experimental settings
    "experimental": {
        // Allow DCP processing in subagent sessions
        "allowSubAgents": false,
        // Enable user-editable prompt overrides under dcp-prompts directories
        // When false (default), prompt override files/directories are ignored
        "customPrompts": false,
    },
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
    // Unified context compression tool and behavior settings
    "compress": {
        // Compression mode: "range" (compress spans into block summaries)
        // or experimental "message" (compress individual raw messages)
        "mode": "range",
        // Permission mode: "allow" (no prompt), "ask" (prompt), "deny" (tool not registered)
        "permission": "allow",
        // Show compression content in a chat notification
        "showCompression": false,
        // Let active summary tokens extend the effective maxContextLimit
        "summaryBuffer": true,
        // Soft upper threshold: above this, DCP keeps injecting strong
        // compression nudges (based on nudgeFrequency), so compression is
        // much more likely. Accepts: number, "X%", or { tokens, percent };
        "maxContextLimit": { "tokens": 500000, "percent": "60%" },
        // Soft lower threshold for reminder nudges: below this, turn/iteration
        // reminders are off (compression less likely). At/above this, reminders
        // are on. Accepts: number, "X%", or { tokens, percent } (smaller wins).
        "minContextLimit": { "tokens": 200000, "percent": "30%" },
        // Optional per-model override for maxContextLimit by providerID/modelID.
        // If present, this wins over the global maxContextLimit.
        // Accepts: number, "X%", or { tokens, percent } (smaller wins).
        // Example:
        // "modelMaxLimits": {
        //     "provider/model": "80%"
        // },
        // Optional per-model override for minContextLimit.
        // If present, this wins over the global minContextLimit.
        // "modelMinLimits": {
        //     "provider/model": "25%"
        // },
        // How often the context-limit nudge fires (1 = every fetch, 5 = every 5th)
        "nudgeFrequency": 5,
        // Start adding compression reminders after this many
        // messages have happened since the last user message
        "iterationNudgeThreshold": 15,
        // Controls how likely compression is after user messages
        // ("strong" = more likely, "soft" = less likely)
        "nudgeForce": "soft",
        // Tool names whose completed outputs are appended to the compression
        "protectedTools": [],
        // Preserve text wrapped in <protect>...</protect> when compressed
        "protectTags": false,
        // Preserve your messages during compression.
        // Warning: large copy-pasted prompts will never be compressed away
        "protectUserMessages": false,
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
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
}
```

</details>

### Dedicated Compression Model (OpenCode V2)

Set `compress.model` to let a separate native model write range summaries. The main
model selects only a topic and range boundaries; the configured model receives
the selected observable messages, tool inputs/results and existing blocks.

```jsonc
{
    "compress": {
        "mode": "range",
        "model": "provider/model#variant",
        // Optional, ordered fallbacks for explicitly classified provider errors:
        "fallbackModels": [],
        // Optional; otherwise derived from the selected input and output budget:
        "modelTimeoutMs": 120000,
    },
}
```

`#variant` is optional. Use a model registered with OpenCode, with known context
and output limits. This mode requires OpenCode 2.0.30 or later; leaving `model`
unset preserves the existing main-authored summaries. Message mode is not supported.

If the selected model advertises image input, selected images are supplied in an
isolated, tool-free native session. Other models receive references only. Inline
attachments are saved under
`${XDG_DATA_HOME:-~/.local/share}/opencode/storage/plugin/dcp/media` using
content-derived filenames. Summaries retain those paths or original URLs; Base64
payloads are excluded from summary text and text-token estimates. Keep these files
alongside session data when moving sessions between machines.

Unknown model limits, oversized input, cancellation and invalid summaries leave
the original context intact. No input is silently truncated. Fallbacks require
an explicit retryable provider status; ambiguous native errors are not retried.

### Commands

DCP provides a TUI panel and one prompt-producing slash command:

- `/dcp` — Opens the DCP panel with context, stats, and manual-mode controls.
- `/dcp-compress [focus]` — Asks the model to run one compression pass. Optional focus text directs what content to compress, following the active `compress.mode`.

### Prompt Overrides

DCP exposes the following editable prompts:

- `system`
- `compress-range`
- `compress-message`
- `context-limit-nudge`
- `turn-nudge`
- `iteration-nudge`

This feature is disabled by default. Set `experimental.customPrompts` to `true` in your DCP config to activate it.

When enabled, managed defaults are written to `~/.config/opencode/dcp-prompts/defaults/` as plain-text prompt files. A single `README.md` in that directory explains each prompt and how to create overrides.

To customize behavior, add a file with the same name under an overrides directory and edit it as plain text.

To reset an override, delete the matching file from your overrides directory.

### Protected Tools

By default, these tools are always protected from pruning:
`task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, `edit`

The `protectedTools` arrays in `commands` and `strategies` add to this default list.

For the `compress` tool, `compress.protectedTools` ensures specific tool outputs are appended to the compressed summary. By default it includes `task`, `skill`, `todowrite`, and `todoread`.

## Impact on Prompt Caching

LLM providers cache prompts based on exact prefix matching. When DCP prunes content, it changes messages, which invalidates cached prefixes from that point forward.

**Trade-off:** Pruning reduces context size but can increase cache misses. The cost
balance depends on your conversation, compression frequency, and provider pricing.

**No impact for:**

- **Request-based billing** — Some providers charge per request, not tokens.
- **Uniform token pricing** — Providers that bill cached and uncached tokens at the same rate.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, local installation,
and testing with the V1/V2 sandbox.

## License

AGPL-3.0-or-later



