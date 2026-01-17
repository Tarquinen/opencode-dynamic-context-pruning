export const NUDGE_BOTH = `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Task Completion:** If a sub-task is complete, decide: use \`discard\` if no valuable context to preserve (default), or use \`extract\` if insights are worth keeping.
2. **Noise Removal:** If you read files or ran commands that yielded no value, use \`discard\` to remove them.
3. **Knowledge Preservation:** If you are holding valuable raw data you'll need to reference later, use \`extract\` to distill the insights and remove the raw entry.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must perform context management.
</instruction>`
