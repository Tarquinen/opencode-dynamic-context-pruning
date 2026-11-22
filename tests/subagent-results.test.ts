import assert from "node:assert/strict"
import test from "node:test"
import { injectExtendedSubAgentResults } from "../lib/messages/inject/subagent-results"
import { Logger } from "../lib/logger"
import { createSessionState, resetSessionState, type WithParts } from "../lib/state"
import {
    extractTaskResultBody,
} from "../lib/subagents/subagent-results"

function buildTaskPart(callID: string, sessionId: string, marker: string) {
    return {
        type: "tool",
        tool: "task",
        callID,
        state: {
            status: "completed",
            metadata: { sessionId },
            output: `<task_result>\n${marker}\n</task_result>`,
        },
    }
}

function buildTaskMessage(callID: string, sessionId: string, marker: string): WithParts {
    return {
        info: {
            id: `msg-${callID}`,
            role: "assistant",
            sessionID: "parent-session",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [buildTaskPart(callID, sessionId, marker)],
    }
}

test("extractTaskResultBody returns task_result body content", () => {
    assert.equal(
        extractTaskResultBody("<task_result>\nROUND-1-MARKER\n</task_result>"),
        "ROUND-1-MARKER",
    )
    assert.equal(extractTaskResultBody("no task result here"), null)
})

test("injectExtendedSubAgentResults keeps each resumed task round distinct", async () => {
    const subAgentSessionId = "subagent-session-1"
    const messages = [
        buildTaskMessage("call-1", subAgentSessionId, "ROUND-1-MARKER answer A"),
        buildTaskMessage("call-2", subAgentSessionId, "ROUND-2-MARKER answer B"),
        buildTaskMessage("call-3", subAgentSessionId, "ROUND-3-MARKER answer C"),
    ]

    const client = {
        session: {
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant" },
                        parts: [{ type: "text", text: "ROUND-3-MARKER answer C" }],
                    },
                ],
            }),
        },
    }

    const state = createSessionState()
    const logger = new Logger(false)

    await injectExtendedSubAgentResults(client, state, logger, messages, true)

    const roundOne = messages[0].parts[0].state.output as string
    const roundTwo = messages[1].parts[0].state.output as string
    const roundThree = messages[2].parts[0].state.output as string

    assert.match(roundOne, /ROUND-1-MARKER answer A/)
    assert.match(roundTwo, /ROUND-2-MARKER answer B/)
    assert.match(roundThree, /ROUND-3-MARKER answer C/)
    assert.doesNotMatch(roundOne, /ROUND-3-MARKER/)
    assert.doesNotMatch(roundTwo, /ROUND-3-MARKER/)

    resetSessionState(state)
    assert.equal(state.subAgentResultCache.size, 0)

    await injectExtendedSubAgentResults(client, state, logger, messages, true)

    assert.match(messages[0].parts[0].state.output as string, /ROUND-1-MARKER answer A/)
    assert.match(messages[1].parts[0].state.output as string, /ROUND-2-MARKER answer B/)
    assert.match(messages[2].parts[0].state.output as string, /ROUND-3-MARKER answer C/)
})

test("injectExtendedSubAgentResults still expands empty task_result from subagent session", async () => {
    const subAgentSessionId = "subagent-session-2"
    const message = buildTaskMessage("call-4", subAgentSessionId, "")
    message.parts[0].state.output = "<task_result>\n</task_result>"

    const client = {
        session: {
            messages: async () => ({
                data: [
                    {
                        info: {
                            id: "sub-msg-1",
                            role: "assistant",
                            sessionID: subAgentSessionId,
                            time: { created: 1 },
                        },
                        parts: [{ type: "text", text: "Expanded subagent reply" }],
                    },
                ],
            }),
        },
    }

    const state = createSessionState()
    await injectExtendedSubAgentResults(
        client,
        state,
        new Logger(false),
        [message],
        true,
    )

    assert.equal(
        extractTaskResultBody(message.parts[0].state.output as string),
        "Expanded subagent reply",
    )
})
