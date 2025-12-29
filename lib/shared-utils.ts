import { encode } from "gpt-tokenizer"
import { SessionState, WithParts } from "./state"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    return msg.info.time.created < state.lastCompaction
}

export const getThreshold = (state: SessionState, messages: WithParts[]): number => {
    let totalTokens = 0

    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== "tool") {
                continue
            }
            if (state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.state.status === "completed") {
                const output = part.state.output
                if (output) {
                    const outputStr = typeof output === "string" ? output : JSON.stringify(output)
                    totalTokens += encode(outputStr).length
                }
            }
        }
    }

    return totalTokens
}

export const getLastUserMessage = (messages: WithParts[]): WithParts | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "user") {
            return msg
        }
    }
    return null
}
