import assert from "node:assert/strict"
import test from "node:test"
import { dispatchDcpServerCommand } from "../lib/v2/slash-command"

test("OpenCode v2 /dcp-compress dispatches the server command with focus text", async () => {
    const calls: Array<{ sessionID: string; name: string; text: string }> = []

    await dispatchDcpServerCommand({
        route: { type: "session", sessionID: "ses_1" },
        name: "dcp-compress",
        text: "keep the auth migration",
        async command(input) {
            calls.push(input)
        },
        open() {
            throw new Error("should stay in the session")
        },
        fail() {
            throw new Error("should not fail")
        },
    })

    assert.deepEqual(calls, [
        { sessionID: "ses_1", name: "dcp-compress", text: "keep the auth migration" },
    ])
})

test("OpenCode v2 /dcp-compress opens the panel when no session is active", async () => {
    let opened = 0
    await dispatchDcpServerCommand({
        route: { type: "home" },
        name: "dcp-compress",
        text: undefined,
        async command() {
            throw new Error("should not dispatch")
        },
        open() {
            opened += 1
        },
        fail() {
            throw new Error("should not fail")
        },
    })

    assert.equal(opened, 1)
})
