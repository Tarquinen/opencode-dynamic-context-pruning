import assert from "node:assert/strict"
import test from "node:test"
import childProcess from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { searchOriginalSemantic } from "../lib/readback"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"

function fixture() {
    const state = createSessionState()
    state.sessionId = "ses_semantic"
    const messages = [
        {
            info: {
                id: "msg_source",
                sessionID: state.sessionId,
                role: "user",
                time: { created: 1 },
            },
            parts: [
                {
                    type: "text",
                    id: "p",
                    text: "Retries use increasing delays.\nA second source line.",
                },
                { type: "reasoning", text: "HIDDEN_REASONING" },
                {
                    type: "tool",
                    tool: "read",
                    state: {
                        status: "completed",
                        input: { password: "SECRET_VALUE" },
                        output: "visible output",
                    },
                },
            ],
        },
        {
            info: { id: "foreign", sessionID: "ses_foreign", role: "user", time: { created: 2 } },
            parts: [{ type: "text", text: "FOREIGN_SECRET" }],
        },
    ] as WithParts[]
    assignMessageRefs(state, messages)
    return { state, messages }
}

test("semantic adapter calls sgrep safely, maps original refs, and removes redacted temporary sources", async (t) => {
    const f = fixture()
    const before = structuredClone(f.state)
    let directory = ""
    t.mock.method(
        childProcess,
        "execFile",
        (_bin: string, args: string[], options: any, callback: any) => {
            directory = options.cwd
            assert.equal(options.shell, undefined)
            assert.deepEqual(args, [
                "--json",
                "-n",
                "2",
                "--model",
                "text",
                "--no-cache",
                "--",
                "--intent retry",
                ".",
            ])
            const files = readdirSync(directory)
            assert.deepEqual(files, ["source-0.txt"])
            const text = readFileSync(join(directory, files[0]!), "utf8")
            assert.match(text, /Retries use increasing delays/)
            assert.doesNotMatch(text, /HIDDEN_REASONING|SECRET_VALUE|FOREIGN_SECRET/)
            callback(
                null,
                JSON.stringify([
                    {
                        path: "source-0.txt",
                        start: 1,
                        end: text.split("\n").length,
                        content: "UNTRUSTED_CLI_TEXT",
                    },
                ]),
            )
        },
    )
    const page = await searchOriginalSemantic(f.state, "ses_semantic", f.messages, {
        mode: "semantic",
        query: "--intent retry",
        limit: 2,
    })
    assert.equal(page.backend, "sgrep")
    assert.equal(page.sources[0]!.sourceId, "msg_source")
    assert.equal(page.sources[0]!.ref, f.state.messageIds.byRawId.get("msg_source"))
    assert.doesNotMatch(page.sources[0]!.text, /UNTRUSTED_CLI_TEXT/)
    assert.equal(page.nextCursor, null)
    assert.equal(existsSync(directory), false)
    assert.deepEqual(f.state, before)
})

test("sgrep failure is explicit and temporary originals are removed without literal fallback", async (t) => {
    const f = fixture()
    let directory = ""
    t.mock.method(
        childProcess,
        "execFile",
        (_bin: string, _args: string[], options: any, callback: any) => {
            directory = options.cwd
            callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "")
        },
    )
    await assert.rejects(
        searchOriginalSemantic(f.state, "ses_semantic", f.messages, {
            mode: "semantic",
            query: "Retries",
        }),
        /ENOENT.*No literal-search fallback/,
    )
    assert.equal(existsSync(directory), false)
})

test("semantic mode rejects foreign CLI paths and unsupported cursor/casing parameters", async (t) => {
    const f = fixture()
    t.mock.method(
        childProcess,
        "execFile",
        (_bin: string, _args: string[], _options: any, callback: any) => {
            callback(null, JSON.stringify([{ path: "../foreign.txt", start: 1, end: 1 }]))
        },
    )
    await assert.rejects(
        searchOriginalSemantic(f.state, "ses_semantic", f.messages, {
            mode: "semantic",
            query: "intent",
        }),
        /outside the selected/,
    )
    for (const extra of [{ cursor: "any" }, { caseSensitive: true }])
        await assert.rejects(
            searchOriginalSemantic(f.state, "ses_semantic", f.messages, {
                mode: "semantic",
                query: "intent",
                ...extra,
            }),
            /does not support/,
        )
})
