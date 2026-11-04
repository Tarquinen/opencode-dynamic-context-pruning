export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

MERGE EXISTING COMPRESSED BLOCKS FIRST: If the session already has compressed blocks and context is still near the limit, the top priority is to consolidate multiple blocks into ONE parent block. Choose startId/endId as the outermost boundaries, include every required block placeholder exactly once (use the placeholder form shown in the compressed-block context), and write a single condensed summary. This reclaims the space every child summary currently occupies. Do NOT keep compressing single fresh messages into new summary blocks - that adds more summaries and keeps the context full.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`
