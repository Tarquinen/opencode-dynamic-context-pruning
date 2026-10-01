import type { IdFormat } from "../message-ids"

export function messagePrompt(format: IdFormat = "xml"): string {
    const compact = format === "compact"
    const message = compact ? "@4@" : "mNNNN"
    return `Collapse selected individual messages in the conversation into detailed summaries.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings, tool outcomes, and user intent details that matter... EVERYTHING that preserves the value of the selected message after the raw message is removed.

USER INTENT FIDELITY
When a selected message contains user intent, preserve that intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote short user instructions when that best preserves exact meaning.

TEMPORAL STATUS OF USER MESSAGES
A summary is HISTORY, not the current instruction.

Approvals, permissions and confirmations are the failure mode here. Text like "go ahead and do it", "yes, do that", or a positive answer to a question tool must be recorded as a past event, never as a live instruction. Otherwise a later turn reads the summary, sees an approval and acts on it - including a PLAN-mode agent starting to modify files after the user has since told it to stop.

- Write it as past tense: "the user approved writing the spec at that point", not "the user approved writing the spec".
- If a later message in the same batch narrows, overrides or cancels it, make the later one operative and say so.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool output, and repetition. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.
If a message contains no significant technical decisions, code changes, or user requirements, produce a minimal one-line summary rather than a detailed one.

MESSAGE IDS
You specify individual raw messages by ID using the injected IDs visible in the conversation:

- \`${message}\` IDs identify raw messages

${compact ? "Each message has an ID like `@7@ [high]`." : 'Each message has an ID inside XML metadata tags like `<dcp-message-id priority="high">m0007</dcp-message-id>`.'}
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as message metadata only, not as content to summarize. ${compact ? "Copy the whole ID, including both `@` characters, into `messageId`, without the priority label." : "Use only the inner `mNNNN` value as the `messageId`."}
${compact ? "The `[low]`, `[medium]`, and `[high]` labels indicate relative context cost." : "The `priority` attribute indicates relative context cost."} You MUST compress high-priority messages when their full text is no longer necessary for the active task.
If prior compress-tool results are present, always compress and summarize them minimally only as part of a broader compression pass. Do not invoke the compress tool solely to re-compress an earlier compression result.
Messages marked as \`${compact ? "@blocked@" : "<dcp-message-id>BLOCKED</dcp-message-id>"}\` cannot be compressed.

Rules:

- Pick each \`messageId\` directly from injected IDs visible in context.
- Only use raw message IDs of the form \`${message}\`.
- ${compact ? "Ignore priority labels when copying an ID: use `@7@`, not `@7@ [high]`. Summary IDs like `@b1@` are not valid message targets." : "Ignore XML attributes such as `priority` when copying the ID; use only the inner `mNNNN` value."}
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
Select MANY messages in a single tool call when they are safe to compress.
Each entry should summarize exactly one message, and the tool can receive as many entries as needed in one batch.

GENERAL CLEANUP
Use the topic "general cleanup" for broad cleanup passes.
During general cleanup, compress all medium and high-priority messages that are not relevant to the active task.
Optimize for reducing context footprint, not for grouping messages by topic.
Do not compress away still-active instructions, unresolved questions, or constraints that are likely to matter soon.
Prioritize the earliest messages in the context as they will be the least relevant to the active task.
General cleanup should be done periodically between other normal compression tool passes, not as the primary form of compression.
`
}

export const COMPRESS_MESSAGE = messagePrompt()
