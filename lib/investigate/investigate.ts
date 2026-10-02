import { tool } from "@opencode-ai/plugin"
import { ensureSessionInitialized } from "../state"
import { fetchSessionMessages } from "../compress/search"
import type { InvestigateToolContext } from "./types"
import { parseBlockIdArg, resolveBlockSlice, truncateMessages } from "./resolve"
import { runInvestigation } from "./subagent"

function buildSchema() {
    return {
        blockId: tool.schema
            .string()
            .describe("Compression block reference to investigate, e.g. 'b3' or '3'."),
        question: tool.schema
            .string()
            .describe("The specific question to answer about the compressed content."),
        maxTokens: tool.schema
            .number()
            .optional()
            .describe("Optional token budget for the original content passed to the subagent."),
    }
}

export function createInvestigateTool(ctx: InvestigateToolContext): ReturnType<typeof tool> {
    return tool({
        description:
            "Answer a question about a DCP compression block (identified by its bN block reference) by delegating to a subagent that reads the ORIGINAL, un-pruned content. Returns ONLY the answer, so the raw content never re-enters your main context. Use this instead of decompressing or reading the original content yourself when you only need a specific answer or clarification about a summary.",
        args: buildSchema(),
        async execute(args, toolCtx) {
            const input = args as { blockId: string; question: string; maxTokens?: number }
            const blockId = parseBlockIdArg(input.blockId)
            if (blockId === null) {
                throw new Error(
                    `Invalid block reference "${input.blockId}". Use a block ID like "b3" or "3".`,
                )
            }

            const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)
            await ensureSessionInitialized(
                ctx.client,
                ctx.state,
                toolCtx.sessionID,
                ctx.logger,
                rawMessages,
                false,
            )

            const slice = resolveBlockSlice(ctx.state, rawMessages, blockId)
            if (slice.messages.length === 0) {
                return `Compression ${slice.blockRef} covers no messages in the current session. Nothing to investigate.`
            }

            const { text } = truncateMessages(slice.messages, input.maxTokens)
            return await runInvestigation(
                ctx.client,
                ctx.logger,
                toolCtx.sessionID,
                slice.block,
                slice.blockRef,
                input.question,
                text,
            )
        },
    })
}
