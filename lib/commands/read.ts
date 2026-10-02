import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { getCurrentParams } from "../token-utils"
import { sendIgnoredMessage } from "../ui/notification"
import { parseBlockIdArg, resolveBlockSlice, truncateMessages } from "../investigate"

export interface ReadOriginalCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleReadOriginalCommand(ctx: ReadOriginalCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)

    const blockArg = args[0]
    if (!blockArg) {
        await sendIgnoredMessage(client, sessionId, "Usage: /dcp read <bN>", params, logger)
        return
    }

    const blockId = parseBlockIdArg(blockArg)
    if (blockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression block ID. Example: /dcp read b3`,
            params,
            logger,
        )
        return
    }

    let slice
    try {
        slice = resolveBlockSlice(state, messages, blockId)
    } catch (error: any) {
        await sendIgnoredMessage(client, sessionId, error?.message ?? String(error), params, logger)
        return
    }

    if (slice.messages.length === 0) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${slice.blockRef} covers no messages in the current session.`,
            params,
            logger,
        )
        return
    }

    const { text } = truncateMessages(slice.messages)
    await sendIgnoredMessage(
        client,
        sessionId,
        `Original content of ${slice.blockRef}:\n\n${text}`,
        params,
        logger,
    )
}
