import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getConfig, validateConfigTypes, getInvalidConfigKeys } from "../lib/config"
import { createCompressRangeTool } from "../lib/compress/range"
import { generateSummary, parseModel, providerFailure, summaryBudget } from "../lib/compress/model"
import { createSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import type { ToolContext } from "../lib/compress/types"
import { nativeToolSignal } from "../lib/v2/cancellation"

const dataHome = mkdtempSync(join(tmpdir(), "dcp-model-tests-"))
process.env.XDG_DATA_HOME = dataHome
after(() => rmSync(dataHome, { recursive: true, force: true }))
const model = "arbitrary/native-model#high"
const metadata = [
    {
        providerID: "arbitrary",
        id: "native-model",
        limit: { context: 200000, output: 32000 },
        variants: [{ id: "high" }],
    },
]
const output = (summary = "Serialize src/cache.ts writes; ELOCK failed; retest not run.") => ({
    text: JSON.stringify({ summary, complete: true }),
})

function fixture(
    generate: NonNullable<ToolContext["summarizer"]>["generate"] = async () => output(),
) {
    const sessionID = `ses_model_fixture_${crypto.randomUUID()}`
    const config = getConfig({
        directory: process.env.XDG_DATA_HOME!,
        client: { tui: { showToast() {} } },
    })
    config.debug = false
    config.pruneNotification = "off"
    config.compress.model = model
    config.compress.fallbackModels = []
    config.compress.modelTimeoutMs = 10000
    config.strategies.deduplication.enabled = false
    config.strategies.purgeErrors.enabled = false
    const messages = [
        { id: "a", role: "user", text: "Fix src/cache.ts; no new dependencies." },
        { id: "b", role: "assistant", text: "ELOCK failed; serialize writes; retest not run." },
        { id: "c", role: "user", text: "UNSELECTED_CONTEXT_MUST_NOT_APPEAR" },
    ].map(({ id, role, text }) => ({
        info: {
            id,
            role,
            sessionID,
            model: { providerID: "arbitrary", modelID: "native-model" },
            time: { created: 1 },
        },
        parts: [{ id: `${id}:text`, messageID: id, sessionID, type: "text", text }],
    })) as WithParts[]
    messages[1]!.parts.push({
        id: "hidden",
        type: "reasoning",
        text: "HIDDEN_REASONING_MUST_NOT_APPEAR",
        messageID: "b",
        sessionID,
    } as WithParts["parts"][number])
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
            getRuntimePrompts: () => ({
                compressRange: "Legacy demands summary",
                compressMessage: "",
            }),
        } as ToolContext["prompts"],
        summarizer: { generate, models: async () => metadata },
    }
    const abort = new AbortController()
    const run = {
        sessionID,
        messageID: "current",
        callID: "call",
        agent: "general",
        directory: process.env.XDG_DATA_HOME!,
        worktree: process.env.XDG_DATA_HOME!,
        abort: abort.signal,
        ask: async () => {},
        metadata() {},
    }
    const args = { topic: "Cache fix", content: [{ startId: "m0001", endId: "m0002" }] }
    return { ctx, run, args, abort, messages }
}

test("generic model config validates and legacy schema is unchanged when unset", () => {
    assert.deepEqual(parseModel("custom/provider/model#variant"), {
        providerID: "custom",
        id: "provider/model",
        variant: "variant",
    })
    assert.throws(() => parseModel("missing-provider"))
    const config = {
        compress: { model, fallbackModels: ["other/id#medium"], modelTimeoutMs: 1000 },
    }
    assert.deepEqual(validateConfigTypes(config), [])
    assert.deepEqual(getInvalidConfigKeys(config), [])
    assert.ok(
        validateConfigTypes({ compress: { model: "bad", fallbackModels: [42], modelTimeoutMs: 0 } })
            .length === 3,
    )
    const { ctx } = fixture()
    const selected = createCompressRangeTool(ctx)
    assert.ok(!selected.description.includes("Legacy demands"))
    const selectionShape = selected.args.content.parse([{ startId: "m0001", endId: "m0002" }])
    assert.ok(!("summary" in selectionShape[0]!))
    delete ctx.config.compress.model
    assert.throws(() =>
        createCompressRangeTool(ctx).args.content.parse([{ startId: "m0001", endId: "m0002" }]),
    )
})

test("configured model receives selected originals, not main summary, other messages, or reasoning", async () => {
    let prompt = ""
    const { ctx, args, run } = fixture(async (input) => {
        prompt = input.prompt
        assert.deepEqual(input.model, parseModel(model))
        return output()
    })
    ctx.config.compress.protectUserMessages = true
    await createCompressRangeTool(ctx).execute(
        {
            ...args,
            content: args.content.map((entry) => ({ ...entry, summary: "MAIN_AUTHORED_SPOOF" })),
        },
        run,
    )
    assert.match(prompt, /Fix src\/cache.ts/)
    assert.match(prompt, /ELOCK failed/)
    assert.doesNotMatch(prompt, /MAIN_AUTHORED_SPOOF|UNSELECTED_CONTEXT|HIDDEN_REASONING/)
    const summary = [...ctx.state.prune.messages.blocksById.values()][0]!.summary
    assert.match(summary, /Serialize src\/cache.ts/)
    assert.match(summary, /no new dependencies/)
})

test("bounds fail before generation; invalid output/cancel/allfail do not allocate blocks", async () => {
    const errors = [
        "",
        '{"summary":"truncated',
        '{"summary":"","complete":true}',
        '{"summary":"not complete","complete":false}',
    ]
    for (const text of errors) {
        const { ctx, args, run } = fixture(async () => ({ text }))
        await assert.rejects(createCompressRangeTool(ctx).execute(args, run))
        assert.equal(ctx.state.prune.messages.blocksById.size, 0)
    }
    let calls = 0
    const badBounds = fixture(async () => {
        calls++
        return output()
    })
    await assert.rejects(
        createCompressRangeTool(badBounds.ctx).execute(
            { ...badBounds.args, content: [{ startId: "m9999", endId: "m0002" }] },
            badBounds.run,
        ),
    )
    assert.equal(calls, 0)
    const cancelled = fixture(async (_, signal) => {
        cancelled.abort.abort(new Error("fixture cancelled"))
        assert.equal(signal.aborted, true)
        return output()
    })
    await assert.rejects(
        createCompressRangeTool(cancelled.ctx).execute(cancelled.args, cancelled.run),
        /cancelled/,
    )
    assert.equal(cancelled.ctx.state.prune.messages.blocksById.size, 0)
    const failed = fixture(async () => {
        throw { _tag: "ProviderError" }
    })
    failed.ctx.config.compress.fallbackModels = [model]
    await assert.rejects(createCompressRangeTool(failed.ctx).execute(failed.args, failed.run))
    assert.equal(failed.ctx.state.prune.messages.blocksById.size, 0)
})

test("fallback is explicit, ordered, provider-error-only", async () => {
    const refs: string[] = []
    const f = fixture(async (input) => {
        refs.push(input.model.id)
        if (refs.length === 1) throw { _tag: "ProviderError", status: 429 }
        return output()
    })
    f.ctx.config.compress.fallbackModels = ["second/model#high"]
    f.ctx.summarizer!.models = async () => [
        ...metadata,
        { ...metadata[0]!, providerID: "second", id: "model" },
    ]
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.deepEqual(refs, ["native-model", "model"])
    assert.equal(
        providerFailure({ _tag: "InvalidRequestError", message: "Model unavailable" }),
        false,
    )
    assert.equal(providerFailure({ name: "APIError", statusCode: 400 }), false)
    assert.equal(providerFailure({ _tag: "ProviderError", status: 400 }), false)
    assert.equal(providerFailure({ _tag: "ProviderError" }), false)
    assert.equal(providerFailure({ name: "APIError", statusCode: 429 }), true)
    assert.equal(providerFailure({ name: "APIError", statusCode: 503 }), true)
    assert.equal(
        providerFailure({ _tag: "Generate.UnavailableError", message: "provider failure" }),
        false,
    )
    for (const failure of [
        { _tag: "InvalidRequestError" },
        { name: "AbortError" },
        { _tag: "ClientError" },
    ]) {
        let count = 0
        const next = fixture(async () => {
            count++
            throw failure
        })
        next.ctx.config.compress.fallbackModels = [model]
        await assert.rejects(createCompressRangeTool(next.ctx).execute(next.args, next.run))
        assert.equal(count, 1)
    }
})

test("all batch summaries validate before any compression commit", async () => {
    let calls = 0
    const { ctx, args, run } = fixture(async () => (++calls === 1 ? output() : { text: "bad" }))
    await assert.rejects(
        createCompressRangeTool(ctx).execute(
            {
                ...args,
                content: [
                    { startId: "m0001", endId: "m0001" },
                    { startId: "m0002", endId: "m0002" },
                ],
            },
            run,
        ),
    )
    assert.equal(calls, 2)
    assert.equal(ctx.state.prune.messages.blocksById.size, 0)
})

test("selected tool evidence is preserved; credential fields and reasoning are excluded", async () => {
    let prompt = ""
    const f = fixture(async (input) => {
        prompt = input.prompt
        return output()
    })
    f.ctx.config.compress.protectedTools = ["shell"]
    f.messages[1]!.parts.push({
        id: "tool",
        type: "tool",
        callID: "tool-call",
        tool: "shell",
        messageID: "b",
        sessionID: f.run.sessionID,
        state: {
            status: "completed",
            input: { command: "npm test", apiKey: "credential-must-not-leak" },
            output: "FAIL cache-race ELOCK",
            time: { start: 1, end: 2 },
        },
    } as WithParts["parts"][number])
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.match(prompt, /FAIL cache-race ELOCK/)
    assert.doesNotMatch(prompt, /credential-must-not-leak/)
    const summary = [...f.ctx.state.prune.messages.blocksById.values()][0]!.summary
    assert.match(summary, /FAIL cache-race ELOCK/)
    assert.doesNotMatch(summary, /credential-must-not-leak/)
})

test("generated unselected block references reject without commits; existing selected blocks survive", async () => {
    const bad = fixture(async () => output("Summary refers to (b999)"))
    await assert.rejects(
        createCompressRangeTool(bad.ctx).execute(bad.args, bad.run),
        /unselected block/,
    )
    assert.equal(bad.ctx.state.prune.messages.blocksById.size, 0)
    const f = fixture()
    delete f.ctx.config.compress.model
    await createCompressRangeTool(f.ctx).execute(
        {
            ...f.args,
            content: [{ startId: "m0001", endId: "m0001", summary: "EXISTING_BLOCK_EVIDENCE" }],
        },
        f.run,
    )
    f.ctx.config.compress.model = model
    let prompt = ""
    f.ctx.summarizer!.generate = async (input) => {
        prompt = input.prompt
        return output()
    }
    await createCompressRangeTool(f.ctx).execute(f.args, f.run)
    assert.match(prompt, /EXISTING_BLOCK_EVIDENCE/)
    assert.match(
        [...f.ctx.state.prune.messages.blocksById.values()].find((block) => block.active)!.summary,
        /EXISTING_BLOCK_EVIDENCE/,
    )
})

test("timeouts do not invoke fallbacks or commit parent compression", async () => {
    let calls = 0
    const f = fixture(async (_, signal) => {
        calls++
        await new Promise<void>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        )
        return output()
    })
    f.ctx.config.compress.modelTimeoutMs = 1
    f.ctx.config.compress.fallbackModels = [model]
    await assert.rejects(createCompressRangeTool(f.ctx).execute(f.args, f.run), /timeout/)
    assert.equal(calls, 1)
    assert.equal(f.ctx.state.prune.messages.blocksById.size, 0)
})

test("summary budget accrues per source segment and never decreases with length", () => {
    assert.equal(summaryBudget(0), 1_200)
    assert.equal(summaryBudget(1), 1_200)
    assert.equal(summaryBudget(8_000), 1_200)
    assert.equal(summaryBudget(20_000), 3_000)
    assert.equal(summaryBudget(20_001), 3_000)
    assert.equal(summaryBudget(50_000), 6_600)
    assert.equal(summaryBudget(100_000), 12_600)
    assert.equal(summaryBudget(100_001), 12_600)
    assert.equal(summaryBudget(200_000), 20_600)
    assert.equal(summaryBudget(300_000), 24_000)
    for (const cut of [20_000, 100_000]) assert.ok(summaryBudget(cut + 1) >= summaryBudget(cut))
    for (let size = 0; size <= 300_000; size += 500)
        assert.ok(
            summaryBudget(size + 1) >= summaryBudget(size),
            `budget dropped at ${size}: ${summaryBudget(size)} -> ${summaryBudget(size + 1)}`,
        )
})

test("generateSummary applies the accrued budget instead of a step-down ratio", async () => {
    const budgets: number[] = []
    const f = fixture(async (input) => {
        budgets.push(Number(/in at most (\d+) tokens/.exec(input.prompt)![1]))
        return output()
    })
    await generateSummary(f.ctx, "topic", "small source", f.abort.signal)
    await generateSummary(f.ctx, "topic", `Evidence line. ${"x".repeat(60_000)}`, f.abort.signal)
    assert.equal(budgets[0], 1_200)
    assert.ok(budgets[1]! > budgets[0]!)
    assert.ok(budgets[1]! <= 24_000)
})

test("unknown capacities and too-large source fail closed without truncating or inference", async () => {
    let calls = 0
    const { ctx, abort } = fixture(async () => {
        calls++
        return output()
    })
    ctx.summarizer!.models = async () => []
    await assert.rejects(
        generateSummary(ctx, "topic", "source", abort.signal),
        /metadata unavailable/,
    )
    ctx.summarizer!.models = async () => [{ ...metadata[0]!, limit: { context: 100, output: 50 } }]
    await assert.rejects(
        generateSummary(ctx, "topic", "source".repeat(1000), abort.signal),
        /no source was truncated/,
    )
    assert.equal(calls, 0)
})

test("native tool signal is forwarded unchanged and absent/malformed capability fails closed", () => {
    const abort = new AbortController()
    assert.equal(nativeToolSignal({ signal: abort.signal }), abort.signal)
    assert.equal(nativeToolSignal({ abort: abort.signal }), undefined)
    assert.equal(nativeToolSignal({ signal: {} }), undefined)
    assert.equal(nativeToolSignal(null), undefined)
    abort.abort()
    assert.throws(() => nativeToolSignal({ signal: abort.signal })!.throwIfAborted())
})
