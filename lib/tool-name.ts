/**
 * Model-facing names for DCP's compress tool.
 *
 * The sleev gateway (api.sleev.ai proxy) injects its own `compress` tool into
 * every completion request and synthesizes the tool result itself, silently
 * shadowing any host-registered tool named "compress" on the wire. DCP
 * therefore registers its tool under a different default name while keeping
 * the "compress" permission action label and accepting legacy "compress"
 * parts from sessions recorded before the rename.
 */

/** Tool name DCP registered before toolName was configurable (kept for legacy session parts). */
export const LEGACY_COMPRESS_TOOL_NAME = "compress"

/** Default model-facing name for DCP's compress tool. */
export const DEFAULT_COMPRESS_TOOL_NAME = "dcp_compress"
