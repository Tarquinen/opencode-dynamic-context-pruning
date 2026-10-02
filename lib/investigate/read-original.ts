import { tool } from "@opencode-ai/plugin"
import { ensureSessionInitialized } from "../state"
import { fetchSessionMessages } from "../compress/search"
import type { InvestigateToolContext } from "./types"
import { parseBlockIdArg, resolveBlockSlice, truncateMessages } from "./resolve"

function buildSchema() {
    return {
        blockId: tool.schema
            .string()
            .describe("Compression block reference to read, e.g. 'b3' or '3'."),
        maxTokens: tool.schema
            .number()
            .optional()
            .describe("Optional token budget for the returned content. Omit to return everything."),
    }
}

export function createReadOriginalTool(ctx: InvestigateToolContext): ReturnType<typeof tool> {
    return tool({
        description:
            "Read the ORIGINAL, un-pruned content of a DCP compression block (identified by its bN block reference) back into the current context. Use this when you need the exact source content that a summary replaced. Prefer the `investigate` tool when you only need an answer to a specific question, since this tool re-expands tokens that were deliberately compressed away.",
        args: buildSchema(),
        async execute(args, toolCtx) {
            const input = args as { blockId: string; maxTokens?: number }
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
                return `Compression ${slice.blockRef} covers no messages in the current session. Its summary may reference nested compressions that were already consumed.`
            }

            const { text, truncated } = truncateMessages(slice.messages, input.maxTokens)
            const header = `Original content of compression ${slice.blockRef} (${slice.messages.length} message(s)${slice.block.topic ? `, topic: ${slice.block.topic}` : ""}):`
            const note = truncated ? `\n\n[truncated to ~${input.maxTokens} tokens]` : ""
            return `${header}\n\n${text}${note}`
        },
    })
}
