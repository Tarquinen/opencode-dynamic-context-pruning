import type { PluginConfig } from "../config"
import type { SessionState } from "../state"
import { parseBoundaryId, type IdFormat } from "../message-ids"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../messages/query"
import { NON_EMPTY_ARRAY_ERROR_MESSAGE, isStringFields, normalizeCompressArgs } from "./args"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import { COMPRESSED_BLOCK_HEADER } from "./state"
import type {
    CompressMessageEntry,
    CompressMessageToolArgs,
    ResolvedMessageCompression,
    ResolvedMessageCompressionsResult,
    SearchContext,
} from "./types"

const MESSAGE_ENTRY_KEYS = ["messageId", "topic", "summary"] as const

export function isMessageEntry(value: unknown): value is CompressMessageEntry {
    return isStringFields(value, MESSAGE_ENTRY_KEYS)
}

const MESSAGE_CONTENT_GUIDANCE =
    're-send with content as an array of message objects: [{ "messageId": "m0001", "topic": "...", "summary": "..." }]. ' +
    "messageId must be the message ID (mNNNN), visible as a <dcp-message-id> tag in context, that your summary covers. " +
    "A summary string alone does not say which message to replace."

export function normalizeMessageArgs(args: unknown): CompressMessageToolArgs {
    return normalizeCompressArgs(args, {
        isEntry: isMessageEntry,
        contentNoun: "messages",
        shapeExample:
            '{ "topic": "...", "content": [{ "messageId": "m0001", "topic": "...", "summary": "..." }] }',
        contentGuidance: MESSAGE_CONTENT_GUIDANCE,
    })
}

interface SkippedIssue {
    kind: string
    messageId: string
}

class SoftIssue extends Error {
    constructor(
        public readonly kind: string,
        public readonly messageId: string,
        message: string,
    ) {
        super(message)
    }
}

export function validateArgs(args: CompressMessageToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error(NON_EMPTY_ARRAY_ERROR_MESSAGE)
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.messageId !== "string" || entry.messageId.trim().length === 0) {
            throw new Error(`${prefix}.messageId is required and must be a non-empty string`)
        }

        if (typeof entry?.topic !== "string" || entry.topic.trim().length === 0) {
            throw new Error(`${prefix}.topic is required and must be a non-empty string`)
        }

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

export function formatResult(
    processedCount: number,
    skippedIssues: string[],
    skippedCount: number,
): string {
    const messageNoun = processedCount === 1 ? "message" : "messages"
    const processedText =
        processedCount > 0
            ? `Compressed ${processedCount} ${messageNoun} into ${COMPRESSED_BLOCK_HEADER}.`
            : "Compressed 0 messages."

    if (skippedCount === 0) {
        return processedText
    }

    const issueNoun = skippedCount === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `${processedText}\nSkipped ${skippedCount} ${issueNoun}:\n${issueLines}`
}

export function formatIssues(skippedIssues: string[], skippedCount: number): string {
    const issueNoun = skippedCount === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `Unable to compress any messages. Found ${skippedCount} ${issueNoun}:\n${issueLines}`
}

function issueTemplates(format: IdFormat): Record<string, [singular: string, plural: string]> {
    const message = format === "compact" ? "@4@" : "mNNNN"
    const block = format === "compact" ? "@b1@" : "bN"
    return {
        blocked: [
            "refers to a protected message and cannot be compressed.",
            "refer to protected messages and cannot be compressed.",
        ],
        "invalid-format": [
            `is invalid. Use an injected raw message ID of the form ${message}.`,
            `are invalid. Use injected raw message IDs of the form ${message}.`,
        ],
        "block-id": [
            `is invalid here. Block IDs like ${block} are not allowed; use an injected ${message} message ID instead.`,
            `are invalid here. Block IDs like ${block} are not allowed; use ${message} message IDs instead.`,
        ],
        "not-in-context": [
            `is not available in the current conversation context. Choose an injected ${message} ID visible in context.`,
            `are not available in the current conversation context. Choose injected ${message} IDs visible in context.`,
        ],
        protected: [
            "refers to a protected message and cannot be compressed.",
            "refer to protected messages and cannot be compressed.",
        ],
        "already-compressed": [
            "is already part of an active compression.",
            "are already part of active compressions.",
        ],
        duplicate: [
            "was selected more than once in this batch.",
            "were each selected more than once in this batch.",
        ],
    }
}

function formatSkippedGroup(kind: string, messageIds: string[], format: IdFormat): string {
    const templates = issueTemplates(format)[kind]
    const ids = messageIds.join(", ")
    const single = messageIds.length === 1
    const prefix = single ? "messageId" : "messageIds"

    if (!templates) {
        return `${prefix} ${ids}: unknown issue.`
    }

    return `${prefix} ${ids} ${single ? templates[0] : templates[1]}`
}

function groupSkippedIssues(issues: SkippedIssue[], format: IdFormat): string[] {
    const groups = new Map<string, string[]>()
    const order: string[] = []

    for (const issue of issues) {
        let ids = groups.get(issue.kind)
        if (!ids) {
            ids = []
            groups.set(issue.kind, ids)
            order.push(issue.kind)
        }
        ids.push(issue.messageId)
    }

    return order.map((kind) => {
        const ids = groups.get(kind)!
        return formatSkippedGroup(kind, ids, format)
    })
}

export function resolveMessages(
    args: CompressMessageToolArgs,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompressionsResult {
    const issues: SkippedIssue[] = []
    const plans: ResolvedMessageCompression[] = []
    const seenMessageIds = new Set<string>()

    for (const entry of args.content) {
        const normalizedMessageId = entry.messageId.trim()
        if (seenMessageIds.has(normalizedMessageId)) {
            issues.push({ kind: "duplicate", messageId: normalizedMessageId })
            continue
        }

        try {
            const plan = resolveMessage(
                {
                    ...entry,
                    messageId: normalizedMessageId,
                },
                searchContext,
                state,
                config,
            )
            seenMessageIds.add(plan.entry.messageId)
            plans.push(plan)
        } catch (error: any) {
            if (error instanceof SoftIssue) {
                issues.push({ kind: error.kind, messageId: error.messageId })
                continue
            }

            throw error
        }
    }

    return {
        plans,
        skippedIssues: groupSkippedIssues(issues, state.idFormat),
        skippedCount: issues.length,
    }
}

function resolveMessage(
    entry: CompressMessageEntry,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompression {
    const blocked = state.idFormat === "compact" ? "@blocked@" : "BLOCKED"
    if (entry.messageId.toLowerCase() === blocked.toLowerCase()) {
        throw new SoftIssue("blocked", blocked, "protected message")
    }

    const parsed = parseBoundaryId(entry.messageId, state.idFormat)

    if (!parsed) {
        throw new SoftIssue("invalid-format", entry.messageId, "invalid format")
    }

    if (parsed.kind === "compressed-block") {
        throw new SoftIssue("block-id", entry.messageId, "block ID used")
    }

    const messageId = state.messageIds.byRef.get(parsed.ref)
    const rawMessage = messageId ? searchContext.rawMessagesById.get(messageId) : undefined
    if (
        !messageId ||
        !rawMessage ||
        !searchContext.rawIndexById.has(messageId) ||
        isIgnoredUserMessage(rawMessage)
    ) {
        throw new SoftIssue("not-in-context", parsed.ref, "not in context")
    }

    const { startReference, endReference } = resolveBoundaryIds(
        searchContext,
        state,
        parsed.ref,
        parsed.ref,
    )
    const selection = resolveSelection(searchContext, startReference, endReference)

    if (isProtectedUserMessage(config, rawMessage)) {
        throw new SoftIssue("protected", parsed.ref, "protected message")
    }

    const pruneEntry = state.prune.messages.byMessageId.get(messageId)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        throw new SoftIssue("already-compressed", parsed.ref, "already compressed")
    }

    return {
        entry: {
            messageId: parsed.ref,
            topic: entry.topic,
            summary: entry.summary,
        },
        selection,
        anchorMessageId: resolveAnchorMessageId(startReference),
    }
}
