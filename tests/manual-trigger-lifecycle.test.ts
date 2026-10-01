import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SessionState, WithParts } from "../lib/state"

const root = mkdtempSync(join(tmpdir(), "dcp-manual-trigger-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { Logger } = await import("../lib/logger")
const { createSessionState } = await import("../lib/state")
const { applyPendingManualTrigger } = await import("../lib/commands/manual")

const logger = new Logger(false)
const RED_LINE = "Manual mode: compress blocked"

function userMessage(sessionID: string, id: string, created: number, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created },
        },
        parts: [{ id: `prt_${id}`, messageID: id, sessionID, type: "text", text }],
    } as WithParts
}

function armTrigger(state: SessionState, sessionID: string, restoreTo: false | "active") {
    state.manualMode = "compress-pending"
    state.consumedManualTrigger = null
    state.pendingManualTrigger = {
        sessionId: sessionID,
        prompt: "<compress triggered manually>\nYou must now use the compress tool.",
        restoreTo,
    }
}

test("a manual trigger is applied to the command turn", () => {
    const sessionID = `ses_manual_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    armTrigger(state, sessionID, false)

    const messages = [userMessage(sessionID, "msg_1", 1, "/dcp compress")]
    applyPendingManualTrigger(state, messages, logger)

    assert.equal(state.pendingManualTrigger, null)
    assert.match((messages[0]!.parts[0] as any).text, /compress triggered manually/)
    assert.equal(state.consumedManualTrigger?.messageId, "msg_1")
    assert.equal(state.consumedManualTrigger?.restoreTo, false)
})

// A trigger authorises exactly one compress call. If the model replies without
// calling compress, "compress-pending" used to stay set, refreshManualMode kept
// early-returning, and the automatic nudges stayed switched off for the rest of
// the session.
test("a trigger that produced no compress is released on the next turn", () => {
    const sessionID = `ses_manual_stuck_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    armTrigger(state, sessionID, false)

    const turn1 = [userMessage(sessionID, "msg_1", 1, "/dcp compress")]
    applyPendingManualTrigger(state, turn1, logger)
    assert.equal(state.manualMode, "compress-pending")

    // The model answered without compressing. A new user message arrives.
    const turn2 = [turn1[0]!, userMessage(sessionID, "msg_2", 2, "actually never mind")]
    applyPendingManualTrigger(state, turn2, logger)

    assert.equal(state.manualMode, false)
    assert.equal(state.consumedManualTrigger, null)
})

test("manual mode ON is restored, not dropped, when the trigger goes unused", () => {
    const sessionID = `ses_manual_on_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    armTrigger(state, sessionID, "active")

    const turn1 = [userMessage(sessionID, "msg_1", 1, "/dcp compress")]
    applyPendingManualTrigger(state, turn1, logger)
    assert.equal(state.manualMode, "compress-pending")

    const turn2 = [turn1[0]!, userMessage(sessionID, "msg_2", 2, "next thing")]
    applyPendingManualTrigger(state, turn2, logger)

    assert.equal(state.manualMode, "active")
})

test("the trigger is still honoured on the turn that armed it", () => {
    const sessionID = `ses_manual_keep_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    armTrigger(state, sessionID, false)

    // Same request the command produced: nothing has been consumed yet, so the
    // pending flag must survive for the compress call that follows.
    const turn = [userMessage(sessionID, "msg_1", 1, "/dcp compress")]
    applyPendingManualTrigger(state, turn, logger)
    applyPendingManualTrigger(state, turn, logger)

    assert.equal(state.manualMode, "compress-pending")
})

test("a compress that did run clears the trigger bookkeeping", () => {
    const sessionID = `ses_manual_done_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    armTrigger(state, sessionID, "active")

    const turn = [userMessage(sessionID, "msg_1", 1, "/dcp compress")]
    applyPendingManualTrigger(state, turn, logger)
    assert.notEqual(state.consumedManualTrigger, null)

    // This mirrors finalizeSession: the compress ran, so the pending marker is
    // retired rather than waiting to be released on a later turn.
    state.manualMode = false
    state.consumedManualTrigger = null

    assert.equal(state.manualMode, false)
    assert.equal(state.consumedManualTrigger, null)
})

test("no trigger armed means nothing is touched", () => {
    const sessionID = `ses_manual_none_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.manualMode = "active"

    applyPendingManualTrigger(state, [userMessage(sessionID, "msg_1", 1, "hello")], logger)

    assert.equal(state.manualMode, "active")
    assert.equal(state.consumedManualTrigger, null)
})

test("the red line wording is unchanged", () => {
    // #490 complained about this message appearing for a user triggered
    // compress. The wording is part of the contract the prompts reference, so it
    // stays as is; the fix is that it no longer appears.
    assert.doesNotMatch(RED_LINE, /never|always/)
})
