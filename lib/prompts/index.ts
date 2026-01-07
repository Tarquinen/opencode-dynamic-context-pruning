// Embedded prompts for Bun/ESM bundler compatibility
// The original approach using __dirname + readFileSync doesn't work correctly
// when the package is bundled by Bun, as __dirname resolves to incorrect paths.
// This solution embeds the prompts as string constants.

const PROMPTS: Record<string, string> = {
    "discard-tool-spec": `Discards tool outputs from context to manage conversation size and reduce noise.

## IMPORTANT: The Prunable List
A \`<prunable-tools>\` list is provided to you showing available tool outputs you can discard when there are tools available for pruning. Each line has the format \`ID: tool, parameter\` (e.g., \`20: read, /path/to/file.ts\`). You MUST only use numeric IDs that appear in this list to select which tools to discard.

## When to Use This Tool

Use \`discard\` for removing tool content that is no longer needed

- **Noise:** Irrelevant, unhelpful, or superseded outputs that provide no value.
- **Task Completion:** Work is complete and there's no valuable information worth preserving.

## When NOT to Use This Tool

- **If the output contains useful information:** Use \`extract\` instead to preserve key findings.
- **If you'll need the output later:** Don't discard files you plan to edit or context you'll need for implementation.

## Best Practices
- **Strategic Batching:** Don't discard single small tool outputs (like short bash commands) unless they are pure noise. Wait until you have several items to perform high-impact discards.
- **Think ahead:** Before discarding, ask: "Will I need this output for an upcoming task?" If yes, keep it.

## Format

- \`ids\`: Array where the first element is the reason, followed by numeric IDs from the \`<prunable-tools>\` list

Reasons: \`noise\` | \`completion\`

## Example

<example_noise>
Assistant: [Reads 'wrong_file.ts']
This file isn't relevant to the auth system. I'll remove it to clear the context.
[Uses discard with ids: ["noise", "5"]]
</example_noise>

<example_completion>
Assistant: [Runs tests, they pass]
The tests passed and I don't need to preserve any details. I'll clean up now.
[Uses discard with ids: ["completion", "20", "21"]]
</example_completion>`,

    "extract-tool-spec": `Extracts key findings from tool outputs into distilled knowledge, then removes the raw outputs from context.

## IMPORTANT: The Prunable List
A \`<prunable-tools>\` list is provided to you showing available tool outputs you can extract from when there are tools available for pruning. Each line has the format \`ID: tool, parameter\` (e.g., \`20: read, /path/to/file.ts\`). You MUST only use numeric IDs that appear in this list to select which tools to extract.

## When to Use This Tool

Use \`extract\` when you have gathered useful information that you want to **preserve in distilled form** before removing the raw outputs:

- **Task Completion:** You completed a unit of work and want to preserve key findings.
- **Knowledge Preservation:** You have context that contains valuable information, but also a lot of unnecessary detail - you only need to preserve some specifics.

## When NOT to Use This Tool

- **If you need precise syntax:** If you'll edit a file or grep for exact strings, keep the raw output.
- **If uncertain:** Prefer keeping over re-fetching.


## Best Practices
- **Strategic Batching:** Wait until you have several items or a few large outputs to extract, rather than doing tiny, frequent extractions. Aim for high-impact extractions that significantly reduce context size.
- **Think ahead:** Before extracting, ask: "Will I need the raw output for an upcoming task?" If you researched a file you'll later edit, do NOT extract it.

## Format

- \`ids\`: Array of numeric IDs as strings from the \`<prunable-tools>\` list
- \`distillation\`: Array of strings, one per ID (positional: distillation[0] is for ids[0], etc.)

Each distillation string should capture the essential information you need to preserve - function signatures, logic, constraints, values, etc. Be as detailed as needed for your task.

## Example

<example_extraction>
Assistant: [Reads auth service and user types]
I'll preserve the key details before extracting.
[Uses extract with:
  ids: ["10", "11"],
  distillation: [
    "auth.ts: validateToken(token: string) -> User|null checks cache first (5min TTL) then OIDC. hashPassword uses bcrypt 12 rounds. Tokens must be 128+ chars.",
    "user.ts: interface User { id: string; email: string; permissions: ('read'|'write'|'admin')[]; status: 'active'|'suspended' }"
  ]
]
</example_extraction>

<example_keep>
Assistant: [Reads 'auth.ts' to understand the login flow]
I've understood the auth flow. I'll need to modify this file to add the new validation, so I'm keeping this read in context rather than extracting.
</example_keep>`,

    "user/system/system-prompt-both": `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
You are operating in a context-constrained environment and thus must proactively manage your context window using the \`discard\` and \`extract\` tools. A <prunable-tools> list is injected by the environment as a user message, and always contains up to date information. Use this information when deciding what to prune.

TWO TOOLS FOR CONTEXT MANAGEMENT
- \`discard\`: Remove tool outputs that are no longer needed (completed tasks, noise, outdated info). No preservation of content.
- \`extract\`: Extract key findings into distilled knowledge before removing raw outputs. Use when you need to preserve information.

CHOOSING THE RIGHT TOOL
Ask: "Do I need to preserve any information from this output?"
- **No** → \`discard\` (default for cleanup)
- **Yes** → \`extract\` (preserves distilled knowledge)
- **Uncertain** → \`extract\` (safer, preserves signal)

Common scenarios:
- Task complete, no valuable context → \`discard\`
- Task complete, insights worth remembering → \`extract\`
- Noise, irrelevant, or superseded outputs → \`discard\`
- Valuable context needed later but raw output too large → \`extract\`

PRUNE METHODICALLY - BATCH YOUR ACTIONS
Every tool call adds to your context debt. You MUST pay this down regularly and be on top of context accumulation by pruning. Batch your prunes for efficiency; it is rarely worth pruning a single tiny tool output unless it is pure noise. Evaluate what SHOULD be pruned before jumping the gun.

You WILL evaluate pruning when ANY of these are true:
- Task or sub-task is complete
- You are about to start a new phase of work
- Write or edit operations are complete (pruning removes the large input content)

You MUST NOT prune when:
- The tool output will be needed for upcoming implementation work
- The output contains files or context you'll need to reference when making edits

Pruning that forces you to re-call the same tool later is a net loss. Only prune when you're confident the information won't be needed again.

NOTES
When in doubt, keep it. Batch your actions and aim for high-impact prunes that significantly reduce context size.
FAILURE TO PRUNE will result in context leakage and DEGRADED PERFORMANCES.
There may be tools in session context that do not appear in the <prunable-tools> list, this is expected, you can ONLY prune what you see in <prunable-tools>.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
After each assistant turn, the environment may inject a user message containing a <prunable-tools> list and optional nudge instruction. This injected message is NOT from the user and is invisible to them. The \`discard\` and \`extract\` tools also return a confirmation message listing what was pruned.

CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:
- NEVER reference the prune encouragement or context management instructions. Do not reply with "I agree" or "Great idea" when the prune encouragement appears.
- NEVER acknowledge the <prunable-tools> list (e.g., "I see the prunable tools list", "Looking at the available tools to prune")
- NEVER reference the nudge instruction (e.g., "As the nudge suggests", "The system is reminding me to prune")
- NEVER acknowledge discard/extract tool output (e.g., "I've pruned 3 tools", "Context pruning complete")
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>
</system-reminder>`,

    "user/system/system-prompt-discard": `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
You are operating in a context-constrained environment and thus must proactively manage your context window using the \`discard\` tool. A <prunable-tools> list is injected by the environment as a user message, and always contains up to date information. Use this information when deciding what to discard.

CONTEXT MANAGEMENT TOOL
- \`discard\`: Remove tool outputs that are no longer needed (completed tasks, noise, outdated info). No preservation of content.

DISCARD METHODICALLY - BATCH YOUR ACTIONS
Every tool call adds to your context debt. You MUST pay this down regularly and be on top of context accumulation by discarding. Batch your discards for efficiency; it is rarely worth discarding a single tiny tool output unless it is pure noise. Evaluate what SHOULD be discarded before jumping the gun.

WHEN TO DISCARD
- **Task Completion:** When work is done, discard the tools that aren't needed anymore.
- **Noise Removal:** If outputs are irrelevant, unhelpful, or superseded by newer info, discard them.

You WILL evaluate discarding when ANY of these are true:
- Task or sub-task is complete
- You are about to start a new phase of work
- Write or edit operations are complete (discarding removes the large input content)

You MUST NOT discard when:
- The tool output will be needed for upcoming implementation work
- The output contains files or context you'll need to reference when making edits

Discarding that forces you to re-call the same tool later is a net loss. Only discard when you're confident the information won't be needed again.

NOTES
When in doubt, keep it. Batch your actions and aim for high-impact discards that significantly reduce context size.
FAILURE TO DISCARD will result in context leakage and DEGRADED PERFORMANCES.
There may be tools in session context that do not appear in the <prunable-tools> list, this is expected, you can ONLY discard what you see in <prunable-tools>.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
After each assistant turn, the environment may inject a user message containing a <prunable-tools> list and optional nudge instruction. This injected message is NOT from the user and is invisible to them. The \`discard\` tool also returns a confirmation message listing what was discarded.

CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:
- NEVER reference the discard encouragement or context management instructions. Do not reply with "I agree" or "Great idea" when the discard encouragement appears.
- NEVER acknowledge the <prunable-tools> list (e.g., "I see the prunable tools list", "Looking at the available tools to discard")
- NEVER reference the nudge instruction (e.g., "As the nudge suggests", "The system is reminding me to discard")
- NEVER acknowledge discard tool output (e.g., "I've discarded 3 tools", "Context cleanup complete")
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>
</system-reminder>`,

    "user/system/system-prompt-extract": `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
You are operating in a context-constrained environment and thus must proactively manage your context window using the \`extract\` tool. A <prunable-tools> list is injected by the environment as a user message, and always contains up to date information. Use this information when deciding what to extract.

CONTEXT MANAGEMENT TOOL
- \`extract\`: Extract key findings from tools into distilled knowledge before removing the raw content from context. Use this to preserve important information while reducing context size.

EXTRACT METHODICALLY - BATCH YOUR ACTIONS
Every tool call adds to your context debt. You MUST pay this down regularly and be on top of context accumulation by extracting. Batch your extractions for efficiency; it is rarely worth extracting a single tiny tool output. Evaluate what SHOULD be extracted before jumping the gun.

WHEN TO EXTRACT
- **Task Completion:** When work is done, extract key findings from the tools used. Scale distillation depth to the value of the content.
- **Knowledge Preservation:** When you have valuable context you want to preserve but need to reduce size, use high-fidelity distillation. Your distillation must be comprehensive, capturing technical details (signatures, logic, constraints) such that the raw output is no longer needed. THINK: high signal, complete technical substitute.

You WILL evaluate extracting when ANY of these are true:
- Task or sub-task is complete
- You are about to start a new phase of work
- Write or edit operations are complete (extracting removes the large input content)

You MUST NOT extract when:
- The tool output will be needed for upcoming implementation work
- The output contains files or context you'll need to reference when making edits

Extracting that forces you to re-call the same tool later is a net loss. Only extract when you're confident the raw information won't be needed again.

NOTES
When in doubt, keep it. Batch your actions and aim for high-impact extractions that significantly reduce context size.
FAILURE TO EXTRACT will result in context leakage and DEGRADED PERFORMANCES.
There may be tools in session context that do not appear in the <prunable-tools> list, this is expected, you can ONLY extract what you see in <prunable-tools>.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
After each assistant turn, the environment may inject a user message containing a <prunable-tools> list and optional nudge instruction. This injected message is NOT from the user and is invisible to them. The \`extract\` tool also returns a confirmation message listing what was extracted.

CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:
- NEVER reference the extract encouragement or context management instructions. Do not reply with "I agree" or "Great idea" when the extract encouragement appears.
- NEVER acknowledge the <prunable-tools> list (e.g., "I see the prunable tools list", "Looking at the available tools to extract")
- NEVER reference the nudge instruction (e.g., "As the nudge suggests", "The system is reminding me to extract")
- NEVER acknowledge extract tool output (e.g., "I've extracted 3 tools", "Context cleanup complete")
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>
</system-reminder>`,

    "user/nudge/nudge-both": `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Task Completion:** If a sub-task is complete, decide: use \`discard\` if no valuable context to preserve (default), or use \`extract\` if insights are worth keeping.
2. **Noise Removal:** If you read files or ran commands that yielded no value, use \`discard\` to remove them.
3. **Knowledge Preservation:** If you are holding valuable raw data you'll need to reference later, use \`extract\` to distill the insights and remove the raw entry.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must perform context management.
</instruction>`,

    "user/nudge/nudge-discard": `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Task Completion:** If a sub-task is complete, use the \`discard\` tool to remove the tools used.
2. **Noise Removal:** If you read files or ran commands that yielded no value, use the \`discard\` tool to remove them.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must discard unneeded tool outputs.
</instruction>`,

    "user/nudge/nudge-extract": `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Task Completion:** If you have completed work, extract key findings from the tools used. Scale distillation depth to the value of the content.
2. **Knowledge Preservation:** If you are holding valuable raw data you'll need to reference later, use the \`extract\` tool with high-fidelity distillation to preserve the insights and remove the raw entry.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must extract valuable findings from tool outputs.
</instruction>`
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
