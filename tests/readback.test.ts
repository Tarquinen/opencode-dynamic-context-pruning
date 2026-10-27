import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "dcp-readback-"))
process.env.XDG_DATA_HOME = root
process.env.XDG_CONFIG_HOME = root
process.env.OPENCODE_CONFIG_DIR = root
after(() => rmSync(root, { recursive: true, force: true }))
const { readOriginalPage, createReadbackTool } = await import("../lib/readback")
const { createSessionState } = await import("../lib/state")
const { assignMessageRefs } = await import("../lib/message-ids")
const { wrapCompressedSummary, applyCompressionState } = await import("../lib/compress/state")
const { buildSearchContext, resolveBoundaryIds, resolveSelection } =
    await import("../lib/compress/search")
const { serializePruneMessagesState } = await import("../lib/state/utils")
const { Logger } = await import("../lib/logger")
import type { WithParts } from "../lib/state"

function fixture(format: "xml" | "compact" = "xml") {
    const sessionID = "ses_readback_fixture"
    const messages = ["alpha", "beta", "gamma", "delta", "epsilon"].map((text, index) => ({
        info: {
            id: `msg_${index}`,
            role: index % 2 ? "assistant" : "user",
            sessionID,
            time: { created: index },
        },
        parts: [{ type: "text", id: `part_${index}`, text, messageID: `msg_${index}`, sessionID }],
    })) as WithParts[]
    const state = createSessionState(format)
    state.sessionId = sessionID
    assignMessageRefs(state, messages)
    const read = (input: Parameters<typeof readOriginalPage>[3]) =>
        readOriginalPage(state, sessionID, messages, input)
    const compress = (startId: string, endId: string, blockId: number, consumed: number[] = []) => {
        const context = buildSearchContext(state, messages)
        const { startReference, endReference } = resolveBoundaryIds(context, state, startId, endId)
        const selection = resolveSelection(context, startReference, endReference)
        applyCompressionState(
            state,
            {
                topic: "fixture",
                batchTopic: "fixture",
                startId,
                endId,
                mode: "range",
                runId: blockId,
                compressMessageId: "msg_4",
                summaryTokens: 5,
            },
            selection,
            messages[startReference.rawIndex]!.info.id,
            blockId,
            wrapCompressedSummary(blockId, `SUMMARY_${blockId}`, format),
            consumed,
        )
    }
    return { state, messages, sessionID, read, compress }
}

test("exact inclusive message ranges, raw IDs, compact aliases and reversed ranges", () => {
    for (const format of ["xml", "compact"] as const) {
        const f = fixture(format)
        const page = f.read({ startId: format === "xml" ? "m0002" : "@2@", endId: "msg_3" })
        assert.deepEqual(
            page.sources.map((source) => [source.sourceId, source.role]),
            [
                ["msg_1", "assistant"],
                ["msg_2", "user"],
                ["msg_3", "assistant"],
            ],
        )
        assert.equal(page.sourceComplete, true)
        assert.equal(page.truncated, false)
        assert.deepEqual(JSON.parse(page.sources[0]!.text), [
            { partId: "part_1", type: "text", text: "beta" },
        ])
        assert.throws(() => f.read({ startId: "msg_4", endId: "msg_1" }), /after/)
    }
})

test("nested repeated compression reads originals once, including inactive children; block end covers its full extent", () => {
    const f = fixture()
    f.compress("m0001", "m0002", 1)
    f.compress("b1", "m0003", 2, [1])
    f.compress("b2", "m0004", 3, [2])
    assert.equal(f.state.prune.messages.blocksById.get(1)!.active, false)
    const before = structuredClone(f.state)
    assert.deepEqual(
        f.read({ startId: "b1" }).sources.map((source) => source.sourceId),
        ["msg_0", "msg_1"],
    )
    assert.deepEqual(
        f.read({ startId: "b3" }).sources.map((source) => source.sourceId),
        ["msg_0", "msg_1", "msg_2", "msg_3"],
    )
    assert.deepEqual(
        f.read({ startId: "m0001", endId: "b3" }).sources.map((source) => source.sourceId),
        ["msg_0", "msg_1", "msg_2", "msg_3"],
    )
    assert.doesNotMatch(JSON.stringify(f.read({ startId: "b3" }).sources), /SUMMARY_/)
    assert.deepEqual(f.state, before)
    assert.match(
        f.state.prune.messages.blocksById.get(3)!.summary,
        /dcp_read\(\{"startId":"b3"\}\)/,
    )
})

test("single block reads exact members rather than an enclosing interval", () => {
    const f = fixture()
    f.compress("m0001", "m0003", 1)
    f.state.prune.messages.blocksById.get(1)!.effectiveMessageIds = ["msg_0", "msg_2"]
    assert.deepEqual(
        f.read({ startId: "b1" }).sources.map((source) => source.sourceId),
        ["msg_0", "msg_2"],
    )
})

test("truncation resumes exactly across source boundaries with Unicode, and cursors reject changed selection/source/session", () => {
    const f = fixture()
    Object.assign(f.messages[1]!.parts[0]!, { text: "中文😀abc".repeat(7) })
    const input = { startId: "msg_0", endId: "msg_2", maxChars: 17 }
    let page = f.read(input)
    const firstCursor = page.nextCursor!
    const assembled = new Map<string, string>()
    let pages = 0
    while (true) {
        pages++
        assert.ok(pages < 100)
        assert.ok(page.sources.reduce((sum, source) => sum + source.text.length, 0) <= 17)
        for (const source of page.sources) {
            const previous = assembled.get(source.sourceId) ?? ""
            assert.equal(previous.length, source.offset)
            assembled.set(source.sourceId, previous + source.text)
        }
        if (!page.truncated) break
        assert.ok(page.nextCursor)
        page = f.read({ ...input, cursor: page.nextCursor! })
    }
    const full = f.read({ ...input, maxChars: 50000 })
    assert.deepEqual(
        [...assembled.values()],
        full.sources.map((source) => source.text),
    )
    assert.equal(page.nextCursor, null)
    assert.throws(() => f.read({ ...input, endId: "msg_3", cursor: firstCursor }), /cursor/)
    const other = fixture()
    other.state.sessionId = "ses_other"
    const otherMessages = structuredClone(f.messages)
    for (const message of otherMessages) message.info.sessionID = "ses_other"
    assert.throws(
        () =>
            readOriginalPage(other.state, "ses_other", otherMessages, {
                ...input,
                cursor: firstCursor,
            }),
        /cursor/,
    )
    Object.assign(f.messages[0]!.parts[0]!, { text: "changed" })
    assert.throws(() => f.read({ ...input, cursor: firstCursor }), /source changed/)
})

test("invalid IDs/cursors/limits fail, missing block originals are reported and never substituted", () => {
    const f = fixture()
    for (const startId of ["b999", "m9999", "../ses_other", "msg_other"])
        assert.throws(() => f.read({ startId }), /unavailable|invalid/)
    assert.throws(() => f.read({ startId: "msg_0", cursor: "bad" }), /cursor/)
    for (const maxChars of [0, -1, 50001, 1.5])
        assert.throws(() => f.read({ startId: "msg_0", maxChars }))
    assert.throws(() => f.read({ startId: "msg_0", sessionID: "ses_other" } as never))
    f.compress("m0001", "m0002", 1)
    f.messages.splice(0, 2)
    const missing = f.read({ startId: "b1" })
    assert.equal(missing.sourceComplete, false)
    assert.deepEqual(missing.missingSourceIds, ["msg_0", "msg_1"])
    assert.deepEqual(missing.sources, [])
    assert.match(missing.unavailable!, /unavailable/)
    assert.throws(() => f.read({ startId: "b1", endId: "msg_3" }), /boundary unavailable/)
})

test("many short sources are capped per page and continue without omissions", () => {
    const f = fixture()
    f.messages.splice(
        0,
        f.messages.length,
        ...Array.from(
            { length: 70 },
            (_, index) =>
                ({
                    info: { ...f.messages[0]!.info, id: `short_${index}`, role: "assistant" },
                    parts: [],
                }) as WithParts,
        ),
    )
    const first = f.read({ startId: "short_0", endId: "short_69", maxChars: 50000 })
    assert.equal(first.sources.length, 64)
    assert.equal(first.truncated, true)
    const last = f.read({ startId: "short_0", endId: "short_69", cursor: first.nextCursor! })
    assert.equal(last.sources.length, 6)
    assert.equal(last.sources[0]!.sourceId, "short_64")
    assert.equal(last.truncated, false)
})

test("foreign session messages, hidden reasoning and common credentials are not exposed", () => {
    const f = fixture()
    const foreign = structuredClone(f.messages[0]!)
    Object.assign(foreign.info, { id: "foreign", sessionID: "ses_foreign" })
    Object.assign(foreign.parts[0]!, { text: "OTHER_SESSION_SECRET" })
    f.messages.push(foreign)
    f.messages[0]!.parts.push({ type: "reasoning", text: "HIDDEN_REASONING" } as never)
    f.messages[0]!.parts.push({
        type: "tool",
        id: "tool",
        callID: "call",
        tool: "read",
        state: {
            input: { password: "CREDENTIAL", path: "src/a.ts" },
            status: "completed",
            output: "observable tool result",
        },
    } as never)
    const page = f.read({ startId: "m0001", endId: "m0005" })
    assert.doesNotMatch(JSON.stringify(page), /OTHER_SESSION_SECRET|HIDDEN_REASONING|CREDENTIAL/)
    assert.match(JSON.stringify(page), /observable tool result|REDACTED/)
    assert.throws(() => f.read({ startId: "foreign" }), /unavailable/)
    assert.throws(
        () => readOriginalPage(f.state, "ses_foreign", f.messages, { startId: "m0001" }),
        /mismatch/,
    )
})

test("tool checks permission before reads and leaves session, compression, accounting and persistence untouched", async () => {
    const f = fixture()
    f.compress("m0001", "m0003", 1)
    const before = structuredClone(f.state)
    const beforeMessages = structuredClone(f.messages)
    const storage = join(root, "opencode", "storage", "plugin", "dcp")
    mkdirSync(storage, { recursive: true })
    const file = join(storage, `${f.sessionID}.json`)
    const persisted = JSON.stringify({
        prune: { tools: {}, messages: serializePruneMessagesState(f.state.prune.messages) },
        stats: f.state.stats,
        nudges: { contextLimitAnchors: [] },
    })
    writeFileSync(file, persisted)
    const calls: string[] = []
    const definition = createReadbackTool({
        state: f.state,
        logger: new Logger(false),
        allowSubAgents: false,
        client: {
            session: {
                get: async ({ path }: any) => {
                    calls.push(`get:${path.id}`)
                    return { data: {} }
                },
                messages: async ({ path }: any) => {
                    calls.push(`messages:${path.id}`)
                    return { data: f.messages }
                },
            },
        },
    })
    const context = {
        sessionID: f.sessionID,
        messageID: "read_call",
        agent: "build",
        directory: root,
        worktree: root,
        abort: new AbortController().signal,
        metadata() {},
        ask: async () => {
            throw new Error("denied")
        },
    }
    await assert.rejects(definition.execute({ startId: "b1" }, context), /denied/)
    assert.deepEqual(calls, [])
    const output = await definition.execute(
        { startId: "b1" },
        {
            ...context,
            ask: async (input) => {
                assert.equal(input.permission, "dcp_read")
            },
        },
    )
    assert.equal(JSON.parse(output as string).sources.length, 3)
    assert.deepEqual(calls, [`get:${f.sessionID}`, `messages:${f.sessionID}`])
    assert.deepEqual(f.state, before)
    assert.deepEqual(f.messages, beforeMessages)
    assert.equal(readFileSync(file, "utf8"), persisted)
    // A mismatched shared V1 state must load only the current session's persisted blocks.
    const empty = createSessionState()
    const fresh = createReadbackTool({
        ...{ state: empty, logger: new Logger(false), allowSubAgents: false },
        client: {
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({ data: f.messages }),
            },
        },
    })
    assert.equal(
        JSON.parse(
            (await fresh.execute({ startId: "b1" }, { ...context, ask: async () => {} })) as string,
        ).sources.length,
        3,
    )
    assert.equal(empty.sessionId, null)
})
