import assert from "node:assert/strict"
import test from "node:test"
import { readOriginalPage } from "../lib/readback"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"

function fixture() {
    const sessionID = "ses_search"
    const state = createSessionState()
    state.sessionId = sessionID
    const messages = ["Alpha needle [.*] 中文", "Second NEEDLE", "unrelated"].map(
        (text, index) => ({
            info: { id: `msg_${index}`, sessionID, role: "user", time: { created: index } },
            parts: [
                { type: "text", id: `part_${index}`, text, sessionID, messageID: `msg_${index}` },
            ],
        }),
    ) as WithParts[]
    assignMessageRefs(state, messages)
    const read = (args: Parameters<typeof readOriginalPage>[3]) =>
        readOriginalPage(state, sessionID, messages, args)
    return { state, messages, read }
}

test("search finds original literal content, returns reusable source IDs, and keeps state unchanged", () => {
    const f = fixture()
    const before = structuredClone(f.state)
    const page = f.read({ query: "needle" })
    assert.deepEqual(
        page.sources.map((x) => x.sourceId),
        ["msg_0", "msg_1"],
    )
    for (const hit of page.sources) {
        assert.ok(hit.ref)
        assert.ok(f.read({ startId: hit.sourceId }).sources[0]!.text.includes(hit.text))
    }
    assert.equal(f.read({ query: "needle", caseSensitive: true }).sources.length, 1)
    assert.equal(f.read({ query: "[.*]" }).sources.length, 1)
    assert.equal(f.read({ query: "中文" }).sources.length, 1)
    assert.equal(f.read({ query: "not found" }).sources.length, 0)
    assert.deepEqual(f.state, before)
})

test("search selection, pagination, snippets, and cursor binding", () => {
    const f = fixture()
    assert.deepEqual(
        f
            .read({ query: "needle", startId: "msg_1", endId: "msg_2" })
            .sources.map((x) => x.sourceId),
        ["msg_1"],
    )
    const page = f.read({ query: "needle", limit: 1, maxChars: 10 })
    assert.equal(page.sources.length, 1)
    assert.ok(page.sources[0]!.text.length <= 10)
    assert.equal(page.truncated, true)
    const next = f.read({ query: "needle", cursor: page.nextCursor! })
    assert.deepEqual(
        next.sources.map((x) => x.sourceId),
        ["msg_1"],
    )
    assert.equal(next.nextCursor, null)
    assert.throws(() => f.read({ query: "Alpha", cursor: page.nextCursor! }), /cursor/)
    assert.throws(
        () => f.read({ query: "needle", caseSensitive: true, cursor: page.nextCursor! }),
        /cursor/,
    )
    Object.assign(f.messages[0]!.parts[0]!, { text: "changed" })
    assert.throws(() => f.read({ query: "needle", cursor: page.nextCursor! }), /cursor/)
})

test("search cannot discover foreign sessions, reasoning, ignored text, or redacted credentials", () => {
    const f = fixture()
    const foreign = structuredClone(f.messages[0]!)
    Object.assign(foreign.info, { id: "foreign", sessionID: "ses_other" })
    Object.assign(foreign.parts[0]!, { text: "private_foreign" })
    f.messages.push(foreign)
    f.messages[0]!.parts.push({ type: "reasoning", text: "private_reasoning" } as never)
    f.messages[0]!.parts.push({ type: "text", ignored: true, text: "private_ignored" } as never)
    f.messages[0]!.parts.push({
        type: "tool",
        tool: "read",
        state: {
            status: "completed",
            input: { password: "private_credential" },
            output: "visible output",
        },
    } as never)
    for (const query of [
        "private_foreign",
        "private_reasoning",
        "private_ignored",
        "private_credential",
    ])
        assert.equal(f.read({ query }).sources.length, 0)
    assert.equal(f.read({ query: "visible output" }).sources.length, 1)
})

test("search rejects invalid parameters and does not make ordinary read selection optional", () => {
    const f = fixture()
    for (const args of [
        {},
        { query: "" },
        { query: "  " },
        { query: "x", endId: "msg_1" },
        { query: "x", limit: 51 },
        { query: "x", limit: 0 },
        { startId: "msg_0", limit: 1 },
    ])
        assert.throws(() => f.read(args))
})


test("search cursor freezes history across completed search tools and appended messages", () => {
    const f = fixture()
    const current = {
        info: { id: "msg_current", sessionID: f.state.sessionId, role: "assistant", time: { created: 4 } },
        parts: [{ type: "tool", id: "part_current", callID: "call_search", tool: "dcp_read", state: { status: "running", input: { query: "needle" } } }],
    } as WithParts
    f.messages.push(current)
    assignMessageRefs(f.state, f.messages)
    const first = readOriginalPage(f.state, f.state.sessionId!, f.messages, { query: "needle", limit: 1 }, current.info.id)
    assert.ok(first.nextCursor)
    assert.equal(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()).endSourceId, "msg_2")
    Object.assign((current.parts[0] as any).state, { status: "completed", output: JSON.stringify(first) })
    const appended = structuredClone(f.messages[1]!)
    Object.assign(appended.info, { id: "msg_appended" })
    f.messages.push(appended)
    assignMessageRefs(f.state, f.messages)
    const next = readOriginalPage(f.state, f.state.sessionId!, f.messages, { query: "needle", cursor: first.nextCursor! }, appended.info.id)
    assert.deepEqual(next.sources.map((hit) => hit.sourceId), ["msg_1"])
    assert.equal(next.nextCursor, null)
    assert.ok(f.read({ startId: next.sources[0]!.sourceId }).sources[0]!.text.includes("NEEDLE"))
    assert.ok(f.read({ query: "needle" }).sources.some((hit) => hit.sourceId === "msg_appended"))
    const tampered = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())
    tampered.endSourceId = "missing_source"
    assert.throws(() => f.read({ query: "needle", cursor: Buffer.from(JSON.stringify(tampered)).toString("base64url") }), /cursor/)
    Object.assign(f.messages[0]!.parts[0]!, { text: "changed historical source" })
    assert.throws(() => f.read({ query: "needle", cursor: first.nextCursor! }), /cursor/)
})
