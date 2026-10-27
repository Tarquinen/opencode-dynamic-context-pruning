import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getConfig } from "../lib/config"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import type { SummaryImage, ToolContext } from "../lib/compress/types"
import { countTokens } from "../lib/token-utils"
import { mediaTokenText } from "../lib/media"

const DATA_HOME = mkdtempSync(join(tmpdir(), "dcp-media-tests-"))
process.env.XDG_DATA_HOME = DATA_HOME
after(() => rmSync(DATA_HOME, { recursive: true, force: true }))

const MODEL = "arbitrary/native-model"
const TEXT_METADATA = [
    { providerID: "arbitrary", id: "native-model", limit: { context: 200000, output: 32000 } },
]
const IMAGE_METADATA = [
    {
        providerID: "arbitrary",
        id: "native-model",
        limit: { context: 200000, output: 32000 },
        capabilities: { input: ["text", "image"] },
    },
]
const B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xkAAAAASUVORK5CYII="
const B64_UNPADDED = B64.replace(/=+$/, "")
const PNG = `data:image/png;base64,${B64}`
const output = (summary = "Selected media summarized; references retained.") => ({
    text: JSON.stringify({ summary, complete: true }),
})

function textMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    text: string,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID,
            model: { providerID: "arbitrary", modelID: "native-model" },
            time: { created: 1 },
        },
        parts: [{ id: `${id}:text`, messageID: id, sessionID, type: "text", text }],
    } as WithParts
}

function fixture(
    mutate?: (messages: WithParts[], sessionID: string) => void,
    mode: "text" | "image" = "text",
) {
    const sessionID = `ses_media_${crypto.randomUUID()}`
    const config = getConfig({ directory: DATA_HOME, client: { tui: { showToast() {} } } })
    config.debug = false
    config.pruneNotification = "off"
    config.compress.model = MODEL
    config.compress.fallbackModels = []
    config.compress.modelTimeoutMs = 10000
    config.compress.mode = "range"
    config.strategies.deduplication.enabled = false
    config.strategies.purgeErrors.enabled = false
    const messages = [
        textMessage("a", "user", sessionID, "Please inspect the attached evidence."),
        textMessage("b", "assistant", sessionID, "Attached evidence reviewed."),
        textMessage("c", "user", sessionID, "UNSELECTED_CONTEXT"),
    ]
    mutate?.(messages, sessionID)
    const calls: Array<{ prompt: string; images?: SummaryImage[] }> = []
    const ctx: ToolContext = {
        client: {
            session: {
                messages: async () => ({ data: messages }),
                get: async () => ({ data: {} }),
            },
        },
        config,
        state: createSessionState(),
        logger: new Logger(false),
        prompts: {
            reload() {},
            getRuntimePrompts: () => ({ compressRange: "", compressMessage: "" }),
        } as ToolContext["prompts"],
        summarizer: {
            models: async () => (mode === "image" ? IMAGE_METADATA : TEXT_METADATA),
            generate: async (input) => {
                calls.push(input)
                return output()
            },
        },
    }
    const abort = new AbortController()
    const run = {
        sessionID,
        messageID: "current",
        callID: "call",
        agent: "general",
        directory: DATA_HOME,
        worktree: DATA_HOME,
        abort: abort.signal,
        ask: async () => {},
        metadata() {},
    }
    const args = { topic: "Media boundaries", content: [{ startId: "m0001", endId: "m0002" }] }
    return { ctx, run, args, messages, calls }
}

function filePart(
    id: string,
    messageID: string,
    sessionID: string,
    url: string,
    mime = "image/png",
) {
    return { id, messageID, sessionID, type: "file" as const, url, mime }
}

function toolPart(
    id: string,
    messageID: string,
    sessionID: string,
    outputValue: unknown,
    tool = "web_fetch",
) {
    return {
        id,
        messageID,
        sessionID,
        type: "tool" as const,
        tool,
        callID: `${id}-call`,
        state: { status: "completed" as const, input: {}, output: outputValue },
    }
}

const storedSummary = (ctx: ToolContext) =>
    [...ctx.state.prune.messages.blocksById.values()].map((block) => block.summary).join("\n")

test("unclosed JSON wrappers still allow an inner media fragment to be reduced", () => {
    const prefix = "{".repeat(50000)
    const image = JSON.stringify({ type: "image", data: B64, mimeType: "image/png" })
    assert.equal(mediaTokenText(prefix), prefix)
    const reduced = mediaTokenText(prefix + image)
    assert.ok(reduced.startsWith(prefix))
    assert.doesNotMatch(reduced, new RegExp(B64))
    assert.match(reduced, /media-reference/)
})

test("mislabeled image bytes in tool logs are preserved as references only", async () => {
    const data = Buffer.from("dcp-image-bytes-0123456789").toString("base64")
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(
            toolPart(
                "tool-b",
                "b",
                sessionID,
                `Test fixture: ${JSON.stringify({ type: "image", data, mimeType: "image/png" })}`,
            ) as never,
        )
    }, "image")
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.ok(!f.calls[0]!.images?.length)
    assert.match(f.calls[0]!.prompt, /Media references are locators only/)
    assert.doesNotMatch(f.calls[0]!.prompt, new RegExp(data))
    assert.match(storedSummary(f.ctx), /Media references retained \(reference-only/)
})

test("user attachment becomes a retrievable reference, never base64 text", async () => {
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-a", "a", sessionID, PNG) as never)
    })
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const call = f.calls[0]!
    assert.doesNotMatch(call.prompt, new RegExp(B64))
    assert.match(call.prompt, /[0-9a-f]{64}\.png/)
    assert.ok(!call.images || call.images.length === 0)
    const summary = storedSummary(f.ctx)
    assert.doesNotMatch(summary, new RegExp(B64))
    assert.match(summary, /Media references retained/)
})

test("mixed tool output content array is reduced to a reference", async () => {
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(
            toolPart("tool-b", "b", sessionID, {
                type: "content",
                value: [
                    { type: "text", text: "chart rendered" },
                    { type: "file", uri: PNG, mime: "image/png" },
                ],
            }) as never,
        )
    })
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const prompt = f.calls[0]!.prompt
    assert.doesNotMatch(prompt, new RegExp(B64))
    assert.match(prompt, /chart rendered/)
    assert.match(prompt, /[0-9a-f]{64}\.png/)
})

test("nested JSON string keeps media out of the prompt", async () => {
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(
            toolPart(
                "tool-b",
                "b",
                sessionID,
                JSON.stringify({ a: { type: "image", data: B64, mimeType: "image/png" } }),
            ) as never,
        )
    })
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.doesNotMatch(f.calls[0]!.prompt, new RegExp(B64))
})

test("image-capable model receives the native image; text-only model gets a reference", async () => {
    const image = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-a", "a", sessionID, PNG) as never)
    }, "image")
    await createCompressRangeTool(image.ctx).execute(image.args, image.run)
    assert.equal(image.calls[0]!.images?.length, 1)
    assert.equal(image.calls[0]!.images?.[0]!.uri, PNG)
    assert.match(image.calls[0]!.images?.[0]!.ref ?? "", /\.png$/)
    assert.match(image.calls[0]!.prompt, /Attached images are selected evidence/)

    const text = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-a", "a", sessionID, PNG) as never)
    }, "text")
    await createCompressRangeTool(text.ctx).execute(text.args, text.run)
    assert.ok(!text.calls[0]!.images || text.calls[0]!.images!.length === 0)
    assert.match(text.calls[0]!.prompt, /Media references are locators only/)
})

test("malformed inline media fails closed and leaves the transcript untouched", async () => {
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts.push(
            filePart("file-a", "a", sessionID, "data:image/png;base64,!!!!") as never,
        )
    })
    const before = JSON.stringify(f.messages)
    await assert.rejects(
        createCompressRangeTool(f.ctx).execute(f.args, f.run),
        /invalid inline media/,
    )
    assert.equal(f.ctx.state.prune.messages.blocksById.size, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(JSON.stringify(f.messages), before)
})

test("duplicate identical media is supplied once", async () => {
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-a", "a", sessionID, PNG) as never)
        messages[0]!.parts.push(filePart("file-a2", "a", sessionID, PNG) as never)
    }, "image")
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.equal(f.calls[0]!.images?.length, 1)
})

test("duplicate media with the same bytes but a different encoding is supplied once", async () => {
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-a", "a", sessionID, PNG) as never)
        messages[0]!.parts.push(
            filePart("file-a2", "a", sessionID, `data:image/png;base64,${B64_UNPADDED}`) as never,
        )
    }, "image")
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.equal(f.calls[0]!.images?.length, 1)
})

test("large inline images do not inflate token counts", () => {
    const large = Buffer.alloc(200000, 7).toString("base64")
    const payload = JSON.stringify({ type: "image", data: large, mimeType: "image/png" })
    const mapped = mediaTokenText(payload)
    assert.ok(!mapped.includes(large.slice(0, 64)))
    assert.ok(countTokens(payload) < 200)
})

test("protected prompt content cannot reintroduce base64 into the stored summary", async () => {
    const f = fixture((messages) => {
        messages[0]!.parts = [
            {
                id: "a:text",
                messageID: "a",
                sessionID: messages[0]!.info.sessionID,
                type: "text",
                text: `Keep this <protect>${PNG}</protect> verbatim.`,
            } as never,
        ]
    })
    f.ctx.config.compress.protectTags = true
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const summary = storedSummary(f.ctx)
    assert.doesNotMatch(summary, new RegExp(B64))
    assert.match(summary, /[0-9a-f]{64}\.png/)
})

test("inline image JSON embedded in surrounding tool text must not reach the prompt", async () => {
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(
            toolPart(
                "tool-b",
                "b",
                sessionID,
                `Tool result: ${JSON.stringify({ type: "image", data: B64, mimeType: "image/png" })}`,
            ) as never,
        )
    })
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.doesNotMatch(f.calls[0]!.prompt, new RegExp(B64))
})

test("data URL with a media type parameter must not reach the prompt as base64", async () => {
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts[0] = {
            id: "a:text",
            messageID: "a",
            sessionID,
            type: "text",
            text: `Chart: data:image/svg+xml;charset=utf-8;base64,${B64} end`,
        } as never
    })
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.doesNotMatch(f.calls[0]!.prompt, new RegExp(B64))
})

test("protected tool output containing a data URL cannot reintroduce base64", async () => {
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(
            toolPart("tool-b", "b", sessionID, `Fetched chart: ${PNG}`, "web_fetch") as never,
        )
    })
    f.ctx.config.compress.protectedTools = ["web_fetch"]
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const summary = storedSummary(f.ctx)
    assert.doesNotMatch(summary, new RegExp(B64))
})

test("protected tool output containing image JSON must not reintroduce base64", async () => {
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(
            toolPart(
                "tool-b",
                "b",
                sessionID,
                { type: "image", data: B64, mimeType: "image/png" },
                "web_fetch",
            ) as never,
        )
    })
    f.ctx.config.compress.protectedTools = ["web_fetch"]
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const summary = storedSummary(f.ctx)
    assert.doesNotMatch(summary, new RegExp(B64))
})

// ---- regression guards for the embedded-JSON scanner ----

test("text and JSON without media are preserved byte-for-byte", () => {
    const inputs = [
        "The quick brown fox. ".repeat(5000),
        "note { alpha } and [ beta ] end",
        `He said "use {config} and [x]" now`,
        JSON.stringify({ note: "a { b } c", list: [1, 2, 3] }),
        JSON.stringify({ note: `say "hi" {x}` }),
        `{\n  "a": 1,\n  "b": [2, 3]\n}`,
        Array.from({ length: 1000 }, (_, i) => JSON.stringify({ i, note: "a {b}" })).join("\n"),
    ]
    for (const input of inputs) assert.equal(mediaTokenText(input), input)
})

test("large valid JSON containing an image is reduced", () => {
    const big = JSON.stringify({
        pad: "x".repeat(400000),
        list: Array.from({ length: 200 }, (_, i) => ({ i, note: "a {b}" })),
        deep: { type: "image", data: B64, mimeType: "image/png" },
    })
    const out = mediaTokenText(big)
    assert.ok(!out.includes(B64))
    assert.ok(out.length > 400000)
    assert.match(out, /\[image\/png attachment\]/)
})

test("multiline image JSON embedded in prose is reduced with surrounding text intact", async () => {
    const embedded = `log start\n${JSON.stringify({ type: "image", data: B64, mimeType: "image/png" }, null, 2)}\nlog end`
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(toolPart("tool-b", "b", sessionID, embedded) as never)
    })
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const prompt = f.calls[0]!.prompt
    assert.doesNotMatch(prompt, new RegExp(B64))
    assert.match(prompt, /log start/)
    assert.match(prompt, /log end/)
    assert.match(prompt, /media-reference/)
    assert.match(prompt, /[0-9a-f]{64}\.png/)
})

test("quoted braces inside embedded JSON do not hide media", () => {
    const embedded = `before {"note":"a { b }","type":"image","data":"${B64}","mimeType":"image/png"} after`
    const out = mediaTokenText(embedded)
    assert.ok(!out.includes(B64))
    assert.match(out, /before /)
    assert.match(out, / after/)
    assert.match(out, /\[image\/png attachment\]/)
})
