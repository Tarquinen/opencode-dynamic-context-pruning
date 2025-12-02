import { tool } from "@opencode-ai/plugin"
import type { JanitorContext } from "./core/janitor"
import { runOnTool } from "./core/janitor"
import { formatPruningResultForTool } from "./ui/notification"
import type { PluginConfig } from "./config"
import type { ToolTracker } from "./api-formats/synth-instruction"
import { resetToolTrackerCount } from "./api-formats/synth-instruction"
import { loadPrompt } from "./core/prompt"
import { isSubagentSession } from "./hooks"

/** Tool description for the prune tool, loaded from prompts/tool.txt */
export const CONTEXT_PRUNING_DESCRIPTION = loadPrompt("tool")

/**
 * Creates the prune tool definition.
 * Returns a tool definition that can be passed to the plugin's tool registry.
 */
export function createPruningTool(client: any, janitorCtx: JanitorContext, config: PluginConfig, toolTracker: ToolTracker): ReturnType<typeof tool> {
    return tool({
        description: CONTEXT_PRUNING_DESCRIPTION,
        args: {
            reason: tool.schema.string().optional().describe(
                "Brief reason for triggering pruning (e.g., 'task complete', 'switching focus')"
            ),
        },
        async execute(args, ctx) {
            // Skip pruning in subagent sessions, but guide the model to continue its work
            // TODO: remove this workaround when PR 4913 is merged (primary_tools config)
            if (await isSubagentSession(client, ctx.sessionID)) {
                return "Pruning is unavailable in subagent sessions. Do not call this tool again. Continue with your current task - if you were in the middle of work, proceed with your next step. If you had just finished, provide your final summary/findings to return to the main agent."
            }

            const result = await runOnTool(
                janitorCtx,
                ctx.sessionID,
                config.strategies.onTool,
                args.reason
            )

            // Skip next idle pruning since we just pruned
            toolTracker.skipNextIdle = true

            // Reset nudge counter to prevent immediate re-nudging after pruning
            if (config.nudge_freq > 0) {
                resetToolTrackerCount(toolTracker)
            }

            const postPruneGuidance = "\n\nYou have already distilled relevant understanding in writing before calling this tool. Do not re-narrate; continue with your next task."

            if (!result || result.prunedCount === 0) {
                return "No prunable tool outputs found. Context is already optimized." + postPruneGuidance
            }

            return formatPruningResultForTool(result, janitorCtx.config.workingDirectory) + postPruneGuidance
        },
    })
}
