// Boundary tests for media extraction/reference handling, centered on the
// defect observed in main's session: tool logs containing non-image bytes
// (literally "dcp-image-bytes-0123456789") mislabeled as image/png and
// image/svg+xml reached the image pipeline and failed with
// "DCP native session did not load selected images".
// Contract under test: base64 never enters the prompt, summary, or token
// counting; image-capable models receive only decodable selected images;
// every payload stays a retrievable, byte-exact reference; invalid base64
// syntax fails closed without mutating prune state.
import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getConfig } from "../lib/config"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import { countTokens } from "../lib/token-utils"
import type { SummaryImage, ToolContext } from "../lib/compress/types"

const DATA_HOME = mkdtempSync(join(tmpdir(), "dcp-media-reference-tests-"))
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

// The exact non-image bytes observed in the failed main-session run.
const FAKE_BYTES = Buffer.from("dcp-image-bytes-0123456789")
const FAKE_B64 = FAKE_BYTES.toString("base64")
const FAKE_PNG_JSON = JSON.stringify({ type: "image", data: FAKE_B64, mimeType: "image/png" })
const FAKE_SVG_URI = `data:image/svg+xml;base64,${FAKE_B64}`
// A real, decodable 1x1 PNG for positive image-bearing fixtures.
const REAL_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const REAL_PNG_BYTES = Buffer.from(REAL_PNG_B64, "base64")
const REAL_PNG = `data:image/png;base64,${REAL_PNG_B64}`

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

function fixture(
    mutate?: (messages: WithParts[], sessionID: string) => void,
    mode: "text" | "image" = "text",
) {
    const sessionID = `ses_media_refs_${crypto.randomUUID()}`
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
    const args = {
        topic: "Media reference boundaries",
        content: [{ startId: "m0001", endId: "m0002" }],
    }
    return { ctx, run, args, messages, calls }
}

const storedSummary = (ctx: ToolContext) =>
    [...ctx.state.prune.messages.blocksById.values()].map((block) => block.summary).join("\n")

// References appear inside a JSON.stringify'd prompt at different nesting
// depths (tool output strings are double-encoded), so backslash runs vary.
// Collapse every run and compare against a collapsed path.
const collapseSlashes = (value: string) => value.replace(/\\+/g, "\\")
const promptHas = (prompt: string, ref: string) =>
    collapseSlashes(prompt).includes(collapseSlashes(ref))

const mediaRef = (bytes: Buffer, extension: string) =>
    join(
        DATA_HOME,
        "opencode",
        "storage",
        "plugin",
        "dcp",
        "media",
        `${createHash("sha256").update(bytes).digest("hex")}.${extension}`,
    )

test("observed case: log-embedded fake png/svg stay reference-only, byte-exact, and compression succeeds", async () => {
    const fakePngRef = mediaRef(FAKE_BYTES, "png")
    const fakeSvgRef = mediaRef(FAKE_BYTES, "svg")
    const f = fixture((messages, sessionID) => {
        messages[1]!.parts.push(
            toolPart("tool-b", "b", sessionID, `Session log: ${FAKE_PNG_JSON}`) as never,
        )
        messages[0]!.parts.push(
            filePart("file-a", "a", sessionID, FAKE_SVG_URI, "image/svg+xml") as never,
        )
    }, "image")
    // With the pre-filtering code these non-image bytes were attached as
    // selected images and the native host failed. The call must now succeed.
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const call = f.calls[0]!
    assert.ok(!call.images?.length, "non-image bytes must not be attached as images")
    assert.match(call.prompt, /Media references are locators only/)
    assert.doesNotMatch(call.prompt, new RegExp(FAKE_B64))
    assert.ok(promptHas(call.prompt, fakePngRef), "png reference in prompt")
    assert.ok(promptHas(call.prompt, fakeSvgRef), "svg reference in prompt")
    assert.equal(
        (await readFile(fakePngRef)).toString("utf8"),
        FAKE_BYTES.toString("utf8"),
        "stored png bytes unchanged",
    )
    assert.equal(
        (await readFile(fakeSvgRef)).toString("utf8"),
        FAKE_BYTES.toString("utf8"),
        "stored svg bytes unchanged",
    )
    const summary = storedSummary(f.ctx)
    assert.match(summary, /Media references retained \(reference-only/)
    assert.doesNotMatch(summary, new RegExp(FAKE_B64))
    assert.ok(summary.includes(fakePngRef) || summary.includes(fakePngRef.replaceAll("\\", "\\\\")))
    assert.ok(summary.includes(fakeSvgRef) || summary.includes(fakeSvgRef.replaceAll("\\", "\\\\")))
})

test("real decodable PNG is attached to the image-capable model and stored byte-exact", async () => {
    const realRef = mediaRef(REAL_PNG_BYTES, "png")
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-a", "a", sessionID, REAL_PNG) as never)
    }, "image")
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const call = f.calls[0]!
    assert.equal(call.images?.length, 1)
    assert.equal(call.images?.[0]!.uri, REAL_PNG)
    assert.equal(call.images?.[0]!.ref, realRef)
    assert.match(call.prompt, /Attached images are selected evidence/)
    assert.doesNotMatch(call.prompt, new RegExp(REAL_PNG_B64))

    assert.equal((await readFile(realRef)).equals(REAL_PNG_BYTES), true, "stored bytes unchanged")
    assert.match(storedSummary(f.ctx), /Media references retained \(images supplied/)
})

test("mixed real and fake media: only decodable images attach, every reference is retained", async () => {
    const realRef = mediaRef(REAL_PNG_BYTES, "png")
    const fakeRef = mediaRef(FAKE_BYTES, "png")
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-real", "a", sessionID, REAL_PNG) as never)
        messages[1]!.parts.push(
            toolPart("tool-b", "b", sessionID, `Fixture log: ${FAKE_PNG_JSON}`) as never,
        )
    }, "image")
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const call = f.calls[0]!
    assert.equal(call.images?.length, 1)
    assert.equal(call.images?.[0]!.ref, realRef)
    assert.ok(promptHas(call.prompt, fakeRef), "fake reference retained in prompt")
    assert.equal((await readFile(fakeRef)).toString("utf8"), FAKE_BYTES.toString("utf8"))
    const summary = storedSummary(f.ctx)
    assert.match(summary, /Media references retained \(images supplied/)
    assert.ok(summary.includes(fakeRef) || summary.includes(fakeRef.replaceAll("\\", "\\\\")))
})

test("duplicate identical media resolves to one attachment and one reference entry", async () => {
    const realRef = mediaRef(REAL_PNG_BYTES, "png")
    const f = fixture((messages, sessionID) => {
        messages[0]!.parts.push(filePart("file-a", "a", sessionID, REAL_PNG) as never)
        messages[1]!.parts.push(
            toolPart("tool-b", "b", sessionID, `Fixture log: ${FAKE_PNG_JSON}`) as never,
        )
        messages[1]!.parts.push(
            toolPart("tool-b2", "b", sessionID, `Repeat log: ${FAKE_PNG_JSON}`) as never,
        )
    }, "image")
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.equal(f.calls[0]!.images?.length, 1)
    const summary = storedSummary(f.ctx)
    const entries = summary
        .split("\n")
        .filter((line) => line.includes("- image/png: ") && line.includes("png"))
    assert.equal(new Set(entries.map((line) => line.trim())).size, entries.length)
    assert.equal((await readFile(realRef)).equals(REAL_PNG_BYTES), true)
})

test("invalid base64 syntax fails closed without mutating prune state or transcript", async () => {
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
    assert.equal(f.ctx.state.prune.messages.byMessageId.size, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(JSON.stringify(f.messages), before)
})

test("protected tag reinsertion of a fake svg data URL cannot reintroduce base64", async () => {
    const fakeSvgRef = mediaRef(FAKE_BYTES, "svg")
    const f = fixture((messages) => {
        messages[0]!.parts = [
            {
                id: "a:text",
                messageID: "a",
                sessionID: messages[0]!.info.sessionID,
                type: "text",
                text: `Keep this <protect>${FAKE_SVG_URI}</protect> verbatim.`,
            } as never,
        ]
    })
    f.ctx.config.compress.protectTags = true
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    const summary = storedSummary(f.ctx)
    assert.doesNotMatch(summary, new RegExp(FAKE_B64))
    assert.ok(summary.includes(fakeSvgRef) || summary.includes(fakeSvgRef.replaceAll("\\", "\\\\")))
})

test("log-embedded media does not inflate token accounting", () => {
    // A large payload embedded in surrounding prose (not pure JSON) must be
    // reduced before counting; the raw base64 alone is ~66k tokens.
    const large = Buffer.alloc(200000, 7).toString("base64")
    const payload = JSON.stringify({ type: "image", data: large, mimeType: "image/png" })
    const log = `Fixture log start ${payload} end`
    assert.ok(log.length > 200000)
    assert.ok(countTokens(log) < 500, `countTokens(log)=${countTokens(log)} must stay small`)
})
