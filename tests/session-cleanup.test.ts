import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "dcp-session-delete-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")

const { Logger } = await import("../lib/logger")
const { createSessionState, saveSessionState } = await import("../lib/state")
const { createEventHandler } = await import("../lib/hooks")

const logger = new Logger(false)
const STORAGE_DIR = join(root, "data/opencode/storage/plugin/dcp")

test.after(() => rmSync(root, { recursive: true, force: true }))

// A deleted session used to leave its state file on disk forever, and the orphan
// kept contributing to the all-time stats (#557).
test("deleting a session removes its persisted state file", async () => {
    const sessionId = `ses_delete_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionId
    state.stats.totalPruneTokens = 12_345
    await saveSessionState(state, logger)

    const filePath = join(STORAGE_DIR, `${sessionId}.json`)
    assert.ok(existsSync(filePath), "precondition: the state file was written")

    const handler = createEventHandler(state, logger)
    await handler({ event: { type: "session.deleted", properties: { info: { id: sessionId } } } })

    assert.equal(existsSync(filePath), false, "the orphaned state file survived")
})

test("deleting another session leaves the active one intact", async () => {
    const keep = `ses_keep_${Date.now()}`
    const drop = `ses_drop_${Date.now()}`
    const state = createSessionState()
    state.sessionId = keep
    await saveSessionState(state, logger)

    const dropState = createSessionState()
    dropState.sessionId = drop
    await saveSessionState(dropState, logger)

    const handler = createEventHandler(state, logger)
    await handler({ event: { type: "session.deleted", properties: { info: { id: drop } } } })

    assert.ok(existsSync(join(STORAGE_DIR, `${keep}.json`)))
    assert.equal(existsSync(join(STORAGE_DIR, `${drop}.json`)), false)
    assert.equal(state.sessionId, keep)
})

test("deleting the active session detaches the in-memory state", async () => {
    const sessionId = `ses_active_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionId
    await saveSessionState(state, logger)

    const handler = createEventHandler(state, logger)
    await handler({ event: { type: "session.deleted", properties: { info: { id: sessionId } } } })

    assert.equal(state.sessionId, null)
})

test("a delete event for an unknown session is harmless", async () => {
    const state = createSessionState()
    state.sessionId = "ses_current"
    const handler = createEventHandler(state, logger)

    await handler({ event: { type: "session.deleted", properties: {} } })
    await handler({ event: { type: "session.deleted" } })
    await handler({ event: { type: "session.deleted", properties: { info: { id: "" } } } })

    assert.equal(state.sessionId, "ses_current")
})

test("the delete branch does not swallow the compression timing branch", async () => {
    // message.part.updated must still be routed to the timing handler.
    const state = createSessionState()
    state.sessionId = "ses_timing"
    const handler = createEventHandler(state, logger)

    await handler({
        event: {
            type: "message.part.updated",
            time: 1_000,
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call_x",
                    messageID: "msg_x",
                    state: { status: "pending" },
                },
            },
        },
    })

    assert.equal(state.compressionTiming.startsByCallId.size, 1)
})

test("unrelated events leave the storage directory alone", async () => {
    const state = createSessionState()
    const handler = createEventHandler(state, logger)
    const before = readdirSync(STORAGE_DIR).sort()

    await handler({ event: { type: "session.updated", properties: { info: { id: "ses_x" } } } })
    await handler({ event: { type: "storage.write" } })

    assert.deepEqual(readdirSync(STORAGE_DIR).sort(), before)
})
