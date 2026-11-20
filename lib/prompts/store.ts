import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import type { Logger } from "../logger"
import { systemPrompt } from "./system"
import { rangePrompt } from "./compress-range"
import { messagePrompt } from "./compress-message"
import type { IdFormat } from "../message-ids"
import { MANUAL_MODE_SYSTEM_EXTENSION, SUBAGENT_SYSTEM_EXTENSION } from "./extensions/system"

// Bundled nudge prompts ship empty on purpose: they are opt-in and users supply
// the text through the prompt override directories.
const CONTEXT_LIMIT_NUDGE = "\n"
const TURN_NUDGE = "\n"
const ITERATION_NUDGE = "\n"

export type PromptKey =
    | "system"
    | "compress-range"
    | "compress-message"
    | "context-limit-nudge"
    | "turn-nudge"
    | "iteration-nudge"

type EditablePromptField =
    | "system"
    | "compressRange"
    | "compressMessage"
    | "contextLimitNudge"
    | "turnNudge"
    | "iterationNudge"

interface PromptDefinition {
    key: PromptKey
    fileName: string
    label: string
    description: string
    usage: string
    runtimeField: EditablePromptField
}

interface PromptOverrideCandidate {
    path: string
}

interface PromptPaths {
    defaultsDir: string
    globalOverridesDir: string
    configDirOverridesDir: string | null
    projectOverridesDir: string | null
}

export interface RuntimePrompts {
    system: string
    compressRange: string
    compressMessage: string
    contextLimitNudge: string
    turnNudge: string
    iterationNudge: string
    manualExtension: string
    subagentExtension: string
}

const PROMPT_DEFINITIONS: PromptDefinition[] = [
    {
        key: "system",
        fileName: "system.md",
        label: "System",
        description: "Core system-level DCP instruction block",
        usage: "Injected into the model system prompt on every request",
        runtimeField: "system",
    },
    {
        key: "compress-range",
        fileName: "compress-range.md",
        label: "Compress Range",
        description: "range-mode compress tool instructions and summary constraints",
        usage: "Registered as the range-mode compress tool description",
        runtimeField: "compressRange",
    },
    {
        key: "compress-message",
        fileName: "compress-message.md",
        label: "Compress Message",
        description: "message-mode compress tool instructions and summary constraints",
        usage: "Registered as the message-mode compress tool description",
        runtimeField: "compressMessage",
    },
    {
        key: "context-limit-nudge",
        fileName: "context-limit-nudge.md",
        label: "Context Limit Nudge",
        description: "High-priority nudge when context is over max threshold",
        usage: "Injected when context usage is beyond configured max limits",
        runtimeField: "contextLimitNudge",
    },
    {
        key: "turn-nudge",
        fileName: "turn-nudge.md",
        label: "Turn Nudge",
        description: "Nudge to compress closed ranges at turn boundaries",
        usage: "Injected when context is between min and max limits at a new user turn",
        runtimeField: "turnNudge",
    },
    {
        key: "iteration-nudge",
        fileName: "iteration-nudge.md",
        label: "Iteration Nudge",
        description: "Nudge after many iterations without user input",
        usage: "Injected when iteration threshold is crossed",
        runtimeField: "iterationNudge",
    },
]

export const PROMPT_KEYS: PromptKey[] = PROMPT_DEFINITIONS.map((definition) => definition.key)

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g
const LEGACY_INLINE_COMMENT_LINE_REGEX = /^[ \t]*\/\/.*?\/\/[ \t]*$/gm
const DCP_SYSTEM_REMINDER_TAG_REGEX =
    /^\s*<dcp-system-reminder\b[^>]*>[\s\S]*<\/dcp-system-reminder>\s*$/i
const DEFAULTS_README_FILE = "README.md"

function bundledPrompts(format: IdFormat): Record<EditablePromptField, string> {
    return {
        system: systemPrompt(format),
        compressRange: rangePrompt(format),
        compressMessage: messagePrompt(format),
        contextLimitNudge: CONTEXT_LIMIT_NUDGE,
        turnNudge: TURN_NUDGE,
        iterationNudge: ITERATION_NUDGE,
    }
}

const INTERNAL_PROMPT_EXTENSIONS = {
    manualExtension: MANUAL_MODE_SYSTEM_EXTENSION,
    subagentExtension: SUBAGENT_SYSTEM_EXTENSION,
}

function createBundledRuntimePrompts(bundled: Record<EditablePromptField, string>): RuntimePrompts {
    return {
        ...bundled,
        manualExtension: INTERNAL_PROMPT_EXTENSIONS.manualExtension,
        subagentExtension: INTERNAL_PROMPT_EXTENSIONS.subagentExtension,
    }
}

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate)) {
            try {
                if (statSync(candidate).isDirectory()) {
                    return candidate
                }
            } catch {
                // ignore inaccessible entries while walking upward
            }
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function resolvePromptPaths(workingDirectory: string): PromptPaths {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    const globalRoot = join(configHome, "opencode", "dcp-prompts")
    const defaultsDir = join(globalRoot, "defaults")
    const globalOverridesDir = join(globalRoot, "overrides")

    const configDirOverridesDir = process.env.OPENCODE_CONFIG_DIR
        ? join(process.env.OPENCODE_CONFIG_DIR, "dcp-prompts", "overrides")
        : null

    const opencodeDir = findOpencodeDir(workingDirectory)
    const projectOverridesDir = opencodeDir ? join(opencodeDir, "dcp-prompts", "overrides") : null

    return {
        defaultsDir,
        globalOverridesDir,
        configDirOverridesDir,
        projectOverridesDir,
    }
}

function stripConditionalTag(content: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>[\\s\\S]*?<\/${tagName}>`, "gi")
    return content.replace(regex, "")
}

function unwrapDcpTagIfWrapped(content: string): string {
    const trimmed = content.trim()

    if (DCP_SYSTEM_REMINDER_TAG_REGEX.test(trimmed)) {
        return trimmed
            .replace(/^\s*<dcp-system-reminder\b[^>]*>\s*/i, "")
            .replace(/\s*<\/dcp-system-reminder>\s*$/i, "")
            .trim()
    }

    return trimmed
}

function normalizeReminderPromptContent(content: string): string {
    const normalized = content.trim()

    if (!normalized) {
        return ""
    }

    const startsWrapped = /^\s*<dcp-system-reminder\b[^>]*>/i.test(normalized)
    const endsWrapped = /<\/dcp-system-reminder>\s*$/i.test(normalized)

    if (startsWrapped !== endsWrapped) {
        return ""
    }

    return unwrapDcpTagIfWrapped(normalized)
}

function stripPromptComments(content: string): string {
    return content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .replace(HTML_COMMENT_REGEX, "")
        .replace(LEGACY_INLINE_COMMENT_LINE_REGEX, "")
}

function toEditablePromptText(definition: PromptDefinition, rawContent: string): string {
    let normalized = stripPromptComments(rawContent).trim()
    if (!normalized) {
        return ""
    }

    if (definition.key === "system") {
        normalized = stripConditionalTag(normalized, "manual")
        normalized = stripConditionalTag(normalized, "subagent")
    }

    if (definition.key !== "compress-range" && definition.key !== "compress-message") {
        normalized = normalizeReminderPromptContent(normalized)
    }

    return normalized.trim()
}

function wrapRuntimePromptContent(definition: PromptDefinition, editableText: string): string {
    const trimmed = editableText.trim()
    if (!trimmed) {
        return ""
    }

    if (definition.key === "compress-range" || definition.key === "compress-message") {
        return trimmed
    }

    return `<dcp-system-reminder>\n${trimmed}\n</dcp-system-reminder>`
}

function buildDefaultPromptFileContent(bundledEditableText: string): string {
    return `${bundledEditableText.trim()}\n`
}

function buildDefaultsReadmeContent(): string {
    const lines: string[] = []
    lines.push("# DCP Prompt Defaults")
    lines.push("")
    lines.push("This directory stores the DCP prompts.")
    lines.push("Each prompt file here should contain plain text only (no XML wrappers).")
    lines.push("")
    lines.push("## Creating Overrides")
    lines.push("")
    lines.push(
        "1. Copy a prompt file from this directory into an overrides directory using the same filename.",
    )
    lines.push("2. Edit the copied file using plain text.")
    lines.push("3. Restart OpenCode.")
    lines.push("")
    lines.push("To reset an override, delete the matching file from your overrides directory.")
    lines.push("")
    lines.push(
        "Do not edit the default prompt files directly, they are just for reference, only files in the overrides directory are used.",
    )
    lines.push("")
    lines.push("Override precedence (highest first):")
    lines.push("1. `.opencode/dcp-prompts/overrides/` (project)")
    lines.push("2. `$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/` (config dir)")
    lines.push("3. `~/.config/opencode/dcp-prompts/overrides/` (global)")
    lines.push("")
    lines.push("## Prompt Files")
    lines.push("")

    for (const definition of PROMPT_DEFINITIONS) {
        lines.push(`- \`${definition.fileName}\``)
        lines.push(`  - Purpose: ${definition.description}.`)
        lines.push(`  - Runtime use: ${definition.usage}.`)
    }

    return `${lines.join("\n")}\n`
}

function readFileIfExists(filePath: string): string | null {
    if (!existsSync(filePath)) {
        return null
    }

    try {
        return readFileSync(filePath, "utf-8")
    } catch {
        return null
    }
}

export class PromptStore {
    private readonly logger: Logger
    private readonly paths: PromptPaths
    private readonly customPromptsEnabled: boolean
    private runtimePrompts: RuntimePrompts
    private readonly bundled: Record<EditablePromptField, string>

    constructor(
        logger: Logger,
        workingDirectory: string,
        customPromptsEnabled = false,
        idFormat: IdFormat = "xml",
    ) {
        this.logger = logger
        this.paths = resolvePromptPaths(workingDirectory)
        this.customPromptsEnabled = customPromptsEnabled
        this.bundled = bundledPrompts(idFormat)
        this.runtimePrompts = createBundledRuntimePrompts(this.bundled)

        if (this.customPromptsEnabled) {
            this.ensureDefaultFiles()
        }
        this.reload()
    }

    getRuntimePrompts(): RuntimePrompts {
        return { ...this.runtimePrompts }
    }

    reload(): void {
        const nextPrompts = createBundledRuntimePrompts(this.bundled)

        if (!this.customPromptsEnabled) {
            this.runtimePrompts = nextPrompts
            return
        }

        for (const definition of PROMPT_DEFINITIONS) {
            const bundledSource = this.bundled[definition.runtimeField]
            const bundledEditable = toEditablePromptText(definition, bundledSource)
            const bundledRuntime = wrapRuntimePromptContent(definition, bundledEditable)
            const fallbackValue = bundledRuntime || bundledSource.trim()
            let effectiveValue = fallbackValue

            for (const candidate of this.getOverrideCandidates(definition.fileName)) {
                const rawOverride = readFileIfExists(candidate.path)
                if (rawOverride === null) {
                    continue
                }

                const editableOverride = toEditablePromptText(definition, rawOverride)
                if (!editableOverride) {
                    this.logger.warn("Prompt override is empty or invalid after normalization", {
                        key: definition.key,
                        path: candidate.path,
                    })
                    continue
                }

                const wrappedOverride = wrapRuntimePromptContent(definition, editableOverride)
                if (!wrappedOverride) {
                    this.logger.warn("Prompt override could not be wrapped for runtime", {
                        key: definition.key,
                        path: candidate.path,
                    })
                    continue
                }

                effectiveValue = wrappedOverride
                break
            }

            nextPrompts[definition.runtimeField] = effectiveValue
        }

        this.runtimePrompts = nextPrompts
    }

    private getOverrideCandidates(fileName: string): PromptOverrideCandidate[] {
        const candidates: PromptOverrideCandidate[] = []

        if (this.paths.projectOverridesDir) {
            candidates.push({
                path: join(this.paths.projectOverridesDir, fileName),
            })
        }

        if (this.paths.configDirOverridesDir) {
            candidates.push({
                path: join(this.paths.configDirOverridesDir, fileName),
            })
        }

        candidates.push({
            path: join(this.paths.globalOverridesDir, fileName),
        })

        return candidates
    }

    private ensureDefaultFiles(): void {
        try {
            mkdirSync(this.paths.defaultsDir, { recursive: true })
            mkdirSync(this.paths.globalOverridesDir, { recursive: true })
        } catch {
            this.logger.warn("Failed to initialize prompt directories", {
                defaultsDir: this.paths.defaultsDir,
                globalOverridesDir: this.paths.globalOverridesDir,
            })
            return
        }

        for (const definition of PROMPT_DEFINITIONS) {
            const bundledEditable = toEditablePromptText(
                definition,
                this.bundled[definition.runtimeField],
            )
            const managedContent = buildDefaultPromptFileContent(
                bundledEditable || this.bundled[definition.runtimeField],
            )
            const filePath = join(this.paths.defaultsDir, definition.fileName)

            try {
                const existing = readFileIfExists(filePath)
                if (existing === managedContent) {
                    continue
                }
                writeFileSync(filePath, managedContent, "utf-8")
            } catch {
                this.logger.warn("Failed to write default prompt file", {
                    key: definition.key,
                    path: filePath,
                })
            }
        }

        const readmePath = join(this.paths.defaultsDir, DEFAULTS_README_FILE)
        const readmeContent = buildDefaultsReadmeContent()

        try {
            const existing = readFileIfExists(readmePath)
            if (existing !== readmeContent) {
                writeFileSync(readmePath, readmeContent, "utf-8")
            }
        } catch {
            this.logger.warn("Failed to write defaults README", {
                path: readmePath,
            })
        }
    }
}
