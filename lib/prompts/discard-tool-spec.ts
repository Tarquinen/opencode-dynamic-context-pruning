export const DISCARD_TOOL_SPEC = `Discards tool outputs from context to manage conversation size and reduce noise.

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
</example_completion>`
