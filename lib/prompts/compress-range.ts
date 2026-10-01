import type { IdFormat } from "../message-ids"

export function rangePrompt(format: IdFormat = "xml"): string {
    const compact = format === "compact"
    const message = compact ? "@4@" : "mNNNN"
    const block = compact ? "@b1@" : "bN"
    const placeholder = compact ? "@b1@" : "(bN)"
    return `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

TEMPORAL STATUS OF USER MESSAGES
A compressed range is HISTORY, not the current instruction. A summary sits behind a [Compressed conversation section] header, and anything inside it has already happened.

Approvals, permissions and confirmations are the failure mode here. Text like "go ahead and do it", "yes, do that", "start writing the spec", or a positive answer to a question tool must be recorded as a past event with its position in the timeline, never as a live instruction. Otherwise a later turn can read the summary, see an approval, and act on it - including a PLAN-mode agent starting to modify files after the user has since told it to stop.

- Write it as past tense with its position: "At that point the user approved writing the spec (third turn of this range). The user has not restated this approval since."
- Never place an approval at the end of the summary, where it reads as the most recent thing the user said.
- Never end a summary with an imperative sentence taken from a user message.
- If the range contains both an approval and a later instruction that narrows, overrides or cancels it, state both and make the later one the operative one.
- If the range ends with a question or an unresolved decision, say that it is unresolved.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`${placeholder}\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

${compact ? "Compressed block IDs look like `@b1@`, distinct from raw message IDs like `@4@`." : "Compressed block IDs always use the `bN` form (never `mNNNN`) and are represented in the same XML metadata tag format."}

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`${placeholder}\` placeholders as RESERVED TOKENS. Do not emit \`${placeholder}\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed ${compact ? "block 1" : "bN"}\` (not as a placeholder).
- Preflight check before finalizing: the set of \`${placeholder}\` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`${compact ? "@b2@" : "(b2)"}\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`${message}\` IDs identify raw messages
- \`${block}\` IDs identify previously compressed blocks

${compact ? "Each message has an ID like `@4@`. Copy the whole marker, including both `@` characters, into `startId` and `endId`." : "Each message has an ID inside XML metadata tags like `<dcp-message-id>...</dcp-message-id>`."}
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`
}

export const COMPRESS_RANGE = rangePrompt()
