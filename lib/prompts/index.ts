// Tool specs
import { DISCARD_TOOL_SPEC } from "./discard-tool-spec"
import { EXTRACT_TOOL_SPEC } from "./extract-tool-spec"

// System prompts
import { SYSTEM_PROMPT_BOTH } from "./system/both"
import { SYSTEM_PROMPT_DISCARD } from "./system/discard"
import { SYSTEM_PROMPT_EXTRACT } from "./system/extract"

// Nudge prompts
import { NUDGE_BOTH } from "./nudge/both"
import { NUDGE_DISCARD } from "./nudge/discard"
import { NUDGE_EXTRACT } from "./nudge/extract"

const PROMPTS: Record<string, string> = {
    "discard-tool-spec": DISCARD_TOOL_SPEC,
    "extract-tool-spec": EXTRACT_TOOL_SPEC,
    "system/system-prompt-both": SYSTEM_PROMPT_BOTH,
    "system/system-prompt-discard": SYSTEM_PROMPT_DISCARD,
    "system/system-prompt-extract": SYSTEM_PROMPT_EXTRACT,
    "nudge/nudge-both": NUDGE_BOTH,
    "nudge/nudge-discard": NUDGE_DISCARD,
    "nudge/nudge-extract": NUDGE_EXTRACT,
}

export function loadPrompt(name: string, vars?: Record<string, string>): string {
    let content = PROMPTS[name]
    if (!content) {
        throw new Error(`Prompt not found: ${name}`)
    }
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
        }
    }
    return content
}
