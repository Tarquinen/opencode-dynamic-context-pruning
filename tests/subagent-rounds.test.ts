import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"

const root = mkdtempSync(join(tmpdir(), "dcp-subagent-rounds-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { Logger } = await import("../lib/logger")
const { createSessionState, resetSessionState } = await import("../lib/state")
const { injectExtendedSubAgentResults } = await import("../lib/messages/inject/subagent-results")

const logger = new Logger(false)

function taskMessage(
    sessionID: string,
    id: string,
    created: number,
    subAgentSessionId: string,
    recorded: string,
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created },
        },
        parts: [
            {
                id: `prt_${id}`,
                messageID: id,
                sessionID,
                type: "tool",
                tool: "task",
                callID: `call_${id}`,
                state: {
                    status: "completed",
                    input: { description: `round ${created}` },
                    output: `<task_result>${recorded}</task_result>`,
                    metadata: { sessionId: subAgentSessionId },
                },
            },
        ],
    } as unknown as WithParts
}

function subAgentSession(subAgentSessionId: string, replies: string[]): WithParts[] {
    return replies.map((reply, index) => ({
        info: {
            id: `sub_msg_${index + 1}`,
            role: "assistant",
            sessionID: subAgentSessionId,
            agent: "subagent",
            model: { providerID: "lab", modelID: "test" },
            time: { created: index + 1 },
        },
        parts: [{ id: `sub_prt_${index + 1}`, messageID: `sub_msg_${index + 1}`, sessionID: subAgentSessionId, type: "text", text: reply }],
    })) as WithParts[]
}

function clientFor(subAgentSessionId: string, replies: string[]) {
    return {
        session: {
            messages: async ({ path }: { path: { id: string } }) => ({
                data: path.id === subAgentSessionId ? subAgentSessionId && subAgentSession(subAgentSessionId, replies) : [],
            }),
            get: async () => ({ data: { parentID: null } }),
        },
    }
}

function recordedBodies(messages: WithParts[]): string[] {
    return messages.map((message) => {
        const part = (message.parts as any[])[0]
        const match = part.state.output.match(/<task_result>([\s\S]*?)<\/task_result>/)
        return match ? match[1] : ""
    })
}

test("resuming a subagent does not rewrite the results of earlier rounds", async () => {
    const parent = "ses_parent"
    const subAgent = "ses_subagent"

    // One subagent session, three rounds, all reachable through the same id.
    const messages = [
        taskMessage(parent, "msg_1", 1, subAgent, "ROUND-1 answer A"),
        taskMessage(parent, "msg_2", 2, subAgent, "ROUND-2 answer B"),
        taskMessage(parent, "msg_3", 3, subAgent, "ROUND-3 answer C"),
    ]
    const state = createSessionState()
    state.sessionId = parent
    const client = clientFor(subAgent, ["ROUND-1 answer A", "ROUND-2 answer B", "ROUND-3 answer C"])

    await injectExtendedSubAgentResults(client as any, state, logger, messages, true)

    assert.deepEqual(
        recordedBodies(messages),
        ["ROUND-1 answer A", "ROUND-2 answer B", "ROUND-3 answer C"],
    )
})

test("the result stays pinned after the session cache is dropped", async () => {
    const parent = "ses_parent_cold"
    const subAgent = "ses_subagent_cold"
    const replies = ["A", "B", "C"]

    const build = () => [
        taskMessage(parent, "msg_1", 1, subAgent, "A"),
        taskMessage(parent, "msg_2", 2, subAgent, "B"),
        taskMessage(parent, "msg_3", 3, subAgent, "C"),
    ]

    const client = clientFor(subAgent, replies)

    // First pass fills the cache.
    const warm = build()
    const warmState = createSessionState()
    warmState.sessionId = parent
    await injectExtendedSubAgentResults(client as any, warmState, logger, warm, true)
    const warmBodies = recordedBodies(warm)

    // A session switch wipes subAgentResultCache, so the second pass runs cold.
    // This is the case the report describes: a resumed subagent makes its own
    // model calls through the same hook between the parent's turns.
    const cold = build()
    const coldState = createSessionState()
    coldState.sessionId = parent
    assert.equal(coldState.subAgentResultCache.size, 0)
    await injectExtendedSubAgentResults(client as any, coldState, logger, cold, true)

    assert.deepEqual(recordedBodies(cold), warmBodies)
    assert.deepEqual(warmBodies, ["A", "B", "C"])
})

test("a fresh subagent session still gets its result expanded", async () => {
    const parent = "ses_parent_fresh"
    const subAgent = "ses_subagent_fresh"
    const messages = [taskMessage(parent, "msg_1", 1, subAgent, "truncated by the host")]
    const state = createSessionState()
    state.sessionId = parent
    const client = clientFor(subAgent, ["the full subagent reply"])

    await injectExtendedSubAgentResults(client as any, state, logger, messages, true)

    assert.deepEqual(recordedBodies(messages), ["the full subagent reply"])
})

test("separate subagent sessions do not interfere with each other", async () => {
    const parent = "ses_parent_multi"
    const messages = [
        taskMessage(parent, "msg_1", 1, "ses_sub_a", "A recorded"),
        taskMessage(parent, "msg_2", 2, "ses_sub_b", "B recorded"),
        taskMessage(parent, "msg_3", 3, "ses_sub_a", "A recorded again"),
    ]
    const state = createSessionState()
    state.sessionId = parent
    const client = {
        session: {
            messages: async ({ path }: { path: { id: string } }) => ({
                data: path.id === "ses_sub_a" ? subAgentSession("ses_sub_a", ["A1", "A2"]) : subAgentSession("ses_sub_b", ["B1"]),
            }),
            get: async () => ({ data: { parentID: null } }),
        },
    }

    await injectExtendedSubAgentResults(client as any, state, logger, messages, true)

    const bodies = recordedBodies(messages)
    assert.equal(bodies[0], "A recorded", "the first call into sub A was rewritten by round 2")
    assert.equal(bodies[1], "B1")
    assert.equal(bodies[2], "A2")
})

test("allowSubAgents off leaves every result untouched", async () => {
    const parent = "ses_parent_off"
    const messages = [taskMessage(parent, "msg_1", 1, "ses_sub_x", "original")]
    const state = createSessionState()
    state.sessionId = parent

    await injectExtendedSubAgentResults(clientFor("ses_sub_x", ["hijacked"]) as any, state, logger, messages, false)

    assert.deepEqual(recordedBodies(messages), ["original"])
})
