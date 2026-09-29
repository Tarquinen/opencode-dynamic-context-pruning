import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"

const root = mkdtempSync(join(tmpdir(), "dcp-v2-ids-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

// Persistence resolves its storage path when imported, after the test home is set.
const { Logger } = await import("../lib/logger")
const { createSessionState, resetSessionState, ensureSessionInitialized } =
    await import("../lib/state")
const { assignMessageRefs, formatMessageRef, parseBoundaryId } = await import("../lib/message-ids")
const { injectMessageIds, buildPriorityMap, prune, stripHallucinations } =
    await import("../lib/messages")
const { stripHallucinationsFromString } = await import("../lib/messages/utils")
const { PromptStore } = await import("../lib/prompts/store")
const { buildCompressedBlockGuidance } = await import("../lib/prompts/extensions/nudge")
const { createCompressRangeTool } = await import("../lib/compress/range")
const { createCompressMessageTool } = await import("../lib/compress/message")
const { wrapCompressedSummary } = await import("../lib/compress/state")
const logger = new Logger(false)

function config(mode: "range" | "message" = "range"): PluginConfig {
    return {
        compress: { mode, permission: "allow", protectedTools: [], protectUserMessages: false },
        manualMode: { enabled: false, automaticStrategies: true },
        experimental: { allowSubAgents: false },
        turnProtection: { enabled: false, turns: 4 },
        strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
        pruneNotification: "off",
        protectedFilePatterns: [],
    } as PluginConfig
}

function messages(sessionID: string): WithParts[] {
    return ["user", "assistant"].map((role, index) => ({
        info: {
            id: `msg_${index + 1}`,
            role,
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created: index + 1 },
        },
        parts: [{ type: "text", text: `Original ${role} content` }],
    })) as WithParts[]
}

function fixture(mode: "range" | "message") {
    const sessionID = `ses_v2_ids_${mode}_${Date.now()}`
    const raw = messages(sessionID)
    const state = createSessionState("compact")
    const settings = config(mode)
    const client = {
        session: {
            messages: async () => ({ data: raw }),
            get: async () => ({ data: { parentID: null } }),
        },
    }
    const prompts = new PromptStore(logger, root, false, "compact")
    const ctx = { client, state, config: settings, logger, prompts }
    const tool = mode === "range" ? createCompressRangeTool(ctx) : createCompressMessageTool(ctx)
    const run = {
        sessionID,
        messageID: "msg_compress",
        ask: async () => {},
        metadata() {},
    } as Parameters<typeof tool.execute>[1]
    return { raw, state, settings, client, tool, run, sessionID }
}

test("V2 IDs are unpadded, distinct from blocks, and survive state resets", () => {
    const state = createSessionState("compact")
    assignMessageRefs(state, messages("ses_ids"))
    assert.equal(state.messageIds.byRawId.get("msg_1"), "@1@")
    assert.equal(state.messageIds.byRef.get("@2@"), "msg_2")
    assert.deepEqual(parseBoundaryId("@4@", "compact"), { kind: "message", ref: "@4@", index: 4 })
    assert.deepEqual(parseBoundaryId("@b1@", "compact"), {
        kind: "compressed-block",
        ref: "@b1@",
        blockId: 1,
    })
    for (const invalid of [
        "4",
        "@04@",
        "@0@",
        "@-1@",
        "@1.5@",
        "m0004",
        "b1",
        "@9007199254740992@",
    ]) {
        assert.equal(parseBoundaryId(invalid, "compact"), null, invalid)
    }
    assert.equal(formatMessageRef(10000, "compact"), "@10000@")
    state.messageIds.nextRef = 10000
    const later = messages("ses_ids")
    later[0]!.info.id = "msg_10000"
    assignMessageRefs(state, later)
    assert.equal(state.messageIds.byRawId.get("msg_10000"), "@10000@")
    resetSessionState(state)
    assignMessageRefs(state, messages("ses_reset"))
    assert.equal(state.messageIds.byRawId.get("msg_1"), "@1@")
    assert.equal(formatMessageRef(4), "m0004")
    assert.equal(parseBoundaryId("@4@"), null)
})

test("V2 cleans echoed IDs and priorities before injecting correct protected/message tags", () => {
    const state = createSessionState("compact")
    const raw = messages("ses_cleanup")
    raw[1]!.parts = [
        { type: "text", text: "It’s 2026.\n@94@ [high]" },
        {
            type: "tool",
            tool: "read",
            callID: "call_read",
            state: { status: "completed", input: {}, output: "Result @b9@ @blocked@" },
        },
    ] as WithParts["parts"]
    stripHallucinations(raw, state.idFormat)
    assert.equal((raw[1]!.parts[0] as any).text, "It’s 2026.\n")
    assert.doesNotMatch(JSON.stringify(raw), /@94@|@b9@|@blocked@|\[high\]/)
    const settings = config("message")
    settings.compress.protectUserMessages = true
    assignMessageRefs(state, raw)
    injectMessageIds(state, settings, raw, buildPriorityMap(settings, state, raw))
    const userTagPart = (raw[0]!.parts as any[]).at(-1)!
    assert.equal(userTagPart.synthetic, true)
    assert.equal(userTagPart.text, "\n@blocked@")
    assert.match((raw[1]!.parts[1] as any).state.output, /@2@ \[low\]$/)
    assert.doesNotMatch(JSON.stringify(raw), /dcp-message-id/)
    assert.equal(
        stripHallucinationsFromString("mail a@b.com; version 4; [high]", "compact"),
        "mail a@b.com; version 4; [high]",
    )
    assert.equal(
        stripHallucinationsFromString("@4@ [high]"),
        "@4@ [high]",
        "V1 cleanup remains XML-only",
    )
})

test("V2 range compression resolves block IDs and expands nested placeholders", async () => {
    const { raw, state, settings, client, tool, run, sessionID } = fixture("range")
    await tool.execute(
        { topic: "First", content: [{ startId: "@1@", endId: "@2@", summary: "FIRST_SUMMARY" }] },
        run,
    )
    assert.match(state.prune.messages.blocksById.get(1)!.summary, /FIRST_SUMMARY[\s\S]*@b1@$/)
    const saved = readFileSync(
        join(root, "data/opencode/storage/plugin/dcp", `${sessionID}.json`),
        "utf8",
    )
    assert.match(saved, /FIRST_SUMMARY/)
    raw.push(
        ...messages(sessionID).map((message, index) => ({
            ...message,
            info: { ...message.info, id: index === 0 ? "msg_compress" : "msg_later" },
        })),
    )
    await tool.execute(
        {
            topic: "Nested",
            content: [{ startId: "@b1@", endId: "@4@", summary: "Before @b1@ after." }],
        },
        { ...run, messageID: "msg_nested" },
    )
    const nested = state.prune.messages.blocksById.get(2)!
    assert.match(nested.summary, /Before FIRST_SUMMARY after\.[\s\S]*@b2@$/)
    assert.doesNotMatch(nested.summary, /@b1@|dcp-message-id/)
    assert.deepEqual(nested.consumedBlockIds, [1])
    assert.equal(state.prune.messages.blocksById.get(1)!.active, false)
    assert.match(buildCompressedBlockGuidance(state), /@b2@/)
    const resumed = createSessionState("compact")
    await ensureSessionInitialized(client, resumed, sessionID, logger, raw, false)
    const projected = structuredClone(raw)
    prune(resumed, logger, settings, projected)
    assert.match(JSON.stringify(projected), /FIRST_SUMMARY.*@b2@/)
    assert.doesNotMatch(JSON.stringify(projected), /Original user content/)
    await assert.rejects(
        tool.execute(
            { topic: "Invalid", content: [{ startId: "m0001", endId: "@4@", summary: "invalid" }] },
            run,
        ),
        /message ID \(@4@\) or block ID \(@b1@\)/,
    )
})

test("V2 message compression reports compact IDs and protects blocked content", async () => {
    const { raw, state, settings, tool, run } = fixture("message")
    settings.compress.protectUserMessages = true
    const result = await tool.execute(
        {
            topic: "Batch",
            content: [
                { messageId: "@blocked@", topic: "Blocked", summary: "No" },
                { messageId: "@1@", topic: "Protected", summary: "No" },
                { messageId: "@b1@", topic: "Block", summary: "No" },
                { messageId: "m0002", topic: "Invalid", summary: "No" },
                { messageId: "@2@", topic: "Assistant", summary: "SECOND_SUMMARY" },
            ],
        },
        run,
    )
    assert.match(String(result), /Compressed 1 message/)
    assert.match(String(result), /@blocked@ refers to a protected message/)
    assert.match(String(result), /Block IDs like @b1@ are not allowed/)
    assert.match(String(result), /form @4@/)
    assert.doesNotMatch(String(result), /mNNNN|dcp-message-id/)
    const projected = structuredClone(raw)
    prune(state, logger, settings, projected)
    assert.match(JSON.stringify(projected), /SECOND_SUMMARY.*@blocked@/)
    assert.doesNotMatch(JSON.stringify(projected), /@b1@/)
})

test("V2 renders persisted summaries with the current markers", () => {
    const state = createSessionState("compact")
    const raw = messages("ses_stored")
    state.prune.messages.activeByAnchorMessageId.set("msg_1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
        anchorMessageId: "msg_1",
        summary: wrapCompressedSummary(1, "STORED"),
    } as any)
    prune(state, logger, config(), raw)
    assert.match((raw[0]!.parts[0] as any).text, /STORED[\s\S]*@b1@$/)
    assert.doesNotMatch((raw[0]!.parts[0] as any).text, /dcp-message-id/)
})

test("V2 prompt defaults, schemas and reloads all describe compact IDs", () => {
    const prompts = new PromptStore(logger, root, true, "compact")
    const defaults = join(process.env.OPENCODE_CONFIG_DIR!, "dcp-prompts", "defaults")
    assert.match(readFileSync(join(defaults, "compress-message.md"), "utf8"), /@7@ \[high\]/)
    for (const mode of ["range", "message"] as const) {
        const { tool } = fixture(mode)
        assert.match(tool.description, /@4@/)
        assert.doesNotMatch(tool.description, /mNNNN|m000\d|dcp-message-id|XML/)
        const schema = tool.args.content.element.shape
        assert.match((mode === "range" ? schema.startId : schema.messageId).description, /@1@/)
    }
    const overrides = join(process.env.OPENCODE_CONFIG_DIR!, "dcp-prompts", "overrides")
    mkdirSync(overrides, { recursive: true })
    writeFileSync(join(overrides, "system.md"), "Custom system instruction")
    prompts.reload()
    assert.match(prompts.getRuntimePrompts().system, /Custom system instruction/)
    assert.match(prompts.getRuntimePrompts().compressMessage, /@blocked@/)
    rmSync(join(overrides, "system.md"))
    const v1 = new PromptStore(logger, root)
    assert.match(v1.getRuntimePrompts().compressMessage, /m0007/)
})
