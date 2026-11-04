import type { IdFormat } from "../message-ids"

export function rangePrompt(format: IdFormat = "xml"): string {
    const compact = format === "compact"
    const message = compact ? "@4@" : "mNNNN"
    const block = compact ? "@b1@" : "bN"
    const placeholder = compact ? "@b1@" : "(bN)"
    return `Collapse a range in the conversation into a detailed summary.

COMPRESSION STRATEGY - READ FIRST
The whole point of compressing is to REDUCE the tokens in context. DCP only replaces what it has already compressed; everything else is still sent verbatim. When a nudge shows a RECLAIMABLE CONTEXT MAP, that map tells you exactly where the reclaimable tokens are. Pick ranges accordingly:

- COMPRESS THE LARGEST RECLAIMABLE CONTENT FIRST: The map's first uncovered region is the biggest chunk of context that no block covers yet. Compress THAT, not a small recent message. A large uncovered region is almost always the right target; a tiny recent message is almost always the wrong one.
- UNCOVERED RAW CONTENT IS FIRST-CLASS: "Uncovered raw content" in the map means messages still sent in full every request. To reclaim them, set startId to the region's first ref and endId to its last ref (or extend endId to the following active block \`bN\` to fold both into one parent, including the required \`(bN)\` placeholder).
- MERGE LARGE BLOCKS WHEN NO BIG UNCOVERED REGION EXISTS: If several active block summaries are themselves large, consolidate multiple blocks into ONE parent (startId/endId = outermost boundary, e.g. b1..b6, every required \`(bN)\` placeholder exactly once) to reclaim their combined summary space.
- SUMMARY MUST BE MUCH SMALLER THAN WHAT IT REPLACES: A summary is a lossy distillation, not a mirror. Aim for the summary to be well under half the size of the content it replaces, often much less. If the summary you are about to write is roughly as long as the content, you are not actually saving context - reconsider the range or write more tersely.
- NO SINGLE-MESSAGE COMPRESSIONS: Never compress a single small fresh message into a new summary block. Each new block adds its own summary to context; a one-message block almost always makes things worse. Go to the largest reclaimable region instead.
- DO NOT CREATE LEFTOVER SUMMARY JUNK: Avoid compressing a single small message into a near-identical long recap. That converts raw messages into an equally large summary block and never helps. Only compress a message if the resulting summary is clearly smaller and the content is genuinely closed.
- RECONSIDER RANGE, NOT ERROR LOOP: If the only range you can produce would not yield a summary meaningfully smaller than the content it replaces, reconsider the range instead of attempting the compression. Do not retry the same narrow range expecting a different result.
- POLL-TURN COOLDOWN: If recent turns only poll a server/status (NO_DONE/NOT_DONE) with no new user instruction, do not compress during the poll loop. Wait for a new user message or a closed phase.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

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

RECURSIVE CONDENSATION
When recursive condensation is enabled (compress.recursiveCondense: true), placeholders are NOT expanded with the full stored block content. Instead:

- Each \`(bN)\` placeholder is replaced with a compact \`[condensed block bN]\` reference, and that block becomes a child of this compression.
- You must therefore write the key content of each referenced block DIRECTLY into your summary text, condensed as needed. Do not rely on the placeholder to preserve details.
- Protected content from child blocks (protected tool outputs, user messages, and protected prompt information) is preserved automatically by the system; you do not need to copy it.
- The overall goal is that this parent summary is meaningfully smaller than the sum of its child summaries, while still capturing every decision, constraint, and finding needed for future work.

When recursive condensation is disabled (the default), the rules in FLOW PRESERVATION WITH PLACEHOLDERS below apply and placeholders are expanded to the full stored block content.

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
