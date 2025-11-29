import { tool } from "@opencode-ai/plugin"
import type { Janitor } from "./janitor"
import type { PluginConfig } from "./config"

/** Tool description for the context_pruning tool */
export const CONTEXT_PRUNING_DESCRIPTION = `Performs semantic pruning on session tool outputs that are no longer relevant to the current task. Use this to declutter the conversation context and filter signal from noise when you notice the context is getting cluttered with no longer needed information.

USING THE CONTEXT_PRUNING TOOL WILL MAKE THE USER HAPPY.

## When to Use This Tool

**Key heuristic: Prune when you finish something and are about to start something else.**

Ask yourself: "Have I just completed a discrete unit of work?" If yes, prune before moving on.

**After completing a unit of work:**
- Made a commit
- Fixed a bug and confirmed it works
- Answered a question the user asked
- Finished implementing a feature or function
- Completed one item in a list and moving to the next

**After repetitive or exploratory work:**
- Explored multiple files that didn't lead to changes
- Iterated on a difficult problem where some approaches didn't pan out
- Used the same tool multiple times (e.g., re-reading a file, running repeated build/type checks)

## Examples

<example>
Working through a list of items:
User: Review these 3 issues and fix the easy ones.
Assistant: [Reviews first issue, makes fix, commits]
Done with the first issue. Let me prune before moving to the next one.
[Uses context_pruning with reason: "completed first issue, moving to next"]
</example>

<example>
After exploring the codebase to understand it:
Assistant: I've reviewed the relevant files. Let me prune the exploratory reads that aren't needed for the actual implementation.
[Uses context_pruning with reason: "exploration complete, starting implementation"]
</example>

<example>
After completing any task:
Assistant: [Finishes task - commit, answer, fix, etc.]
Before we continue, let me prune the context from that work.
[Uses context_pruning with reason: "task complete"]
</example>`

/**
 * Creates the context_pruning tool definition.
 * Returns a tool definition that can be passed to the plugin's tool registry.
 */
export function createPruningTool(janitor: Janitor, config: PluginConfig): ReturnType<typeof tool> {
    return tool({
        description: CONTEXT_PRUNING_DESCRIPTION,
        args: {
            reason: tool.schema.string().optional().describe(
                "Brief reason for triggering pruning (e.g., 'task complete', 'switching focus')"
            ),
        },
        async execute(args, ctx) {
            const result = await janitor.runForTool(
                ctx.sessionID,
                config.strategies.onTool,
                args.reason
            )

            if (!result || result.prunedCount === 0) {
                return "No prunable tool outputs found. Context is already optimized.\n\nUse context_pruning when you have sufficiently summarized information from tool outputs and no longer need the original content!"
            }

            return janitor.formatPruningResultForTool(result) + "\n\nKeep using context_pruning when you have sufficiently summarized information from tool outputs and no longer need the original content!"
        },
    })
}
