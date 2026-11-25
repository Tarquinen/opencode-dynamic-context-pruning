import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { getCurrentParams } from "../token-utils"
import { sendIgnoredMessage } from "../ui/notification"
import {
    parseBlockIdArg,
    resolveBlockSlice,
    runInvestigation,
    truncateMessages,
} from "../investigate"

export interface InvestigateCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleInvestigateCommand(ctx: InvestigateCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)

    const blockArg = args[0]
    const question = args.slice(1).join(" ").trim()
    if (!blockArg || !question) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Usage: /dcp investigate <bN> "<question>"`,
            params,
            logger,
        )
        return
    }

    const blockId = parseBlockIdArg(blockArg)
    if (blockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression block ID. Example: /dcp investigate b3 "what was the error?"`,
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
    const answer = await runInvestigation(
        client,
        logger,
        sessionId,
        slice.block,
        slice.blockRef,
        question,
        text,
    )
    await sendIgnoredMessage(client, sessionId, answer, params, logger)
}
