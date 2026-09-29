import type { RuntimePrompts } from "./store"
import { DEFAULT_COMPRESS_TOOL_NAME, LEGACY_COMPRESS_TOOL_NAME } from "../tool-name"
export type { PromptStore, RuntimePrompts } from "./store"

/**
 * Rewrite generic "compress tool" mentions in model-facing prompt text to the
 * configured tool name. The sleev gateway shadows the literal name "compress"
 * on the wire (it injects its own `compress` tool into every request), so
 * prompt text must reference DCP's actual registered name. Prompts written
 * for the legacy name need no rewrite.
 */
export const withCompressToolName = (text: string, toolName: string): string =>
    toolName === LEGACY_COMPRESS_TOOL_NAME
        ? text
        : text.replaceAll("compress tool", `${toolName} tool`)

export function renderSystemPrompt(
    prompts: RuntimePrompts,
    protectedToolsExtension?: string,
    manual?: boolean,
    subagent?: boolean,
    toolName: string = DEFAULT_COMPRESS_TOOL_NAME,
): string {
    const extensions: string[] = []

    if (protectedToolsExtension) {
        extensions.push(protectedToolsExtension.trim())
    }

    if (manual) {
        extensions.push(withCompressToolName(prompts.manualExtension, toolName).trim())
    }

    if (subagent) {
        extensions.push(prompts.subagentExtension.trim())
    }

    return [withCompressToolName(prompts.system, toolName).trim(), ...extensions]
        .filter(Boolean)
        .join("\n\n")
        .replace(/\n([ \t]*\n)+/g, "\n\n")
        .trim()
}
