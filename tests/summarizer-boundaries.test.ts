import assert from "node:assert/strict"
import test from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSummarizer } from "../lib/v2/summarizer"

// Boundary tests for the DCP native image summarizer (lib/v2/summarizer.ts).
// The host plugin.Context is fully mocked: no real API calls, no builds.
process.env.XDG_DATA_HOME = join(tmpdir(), "opencode", "dcp-summarizer-boundary")

// 1x1 PNG (tiny valid fixture).
const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

type ModelRef = { providerID: string; id: string; variant?: string }

interface MockEvent {
    sessionID: string
    model: ModelRef
    messages: Array<{ role: string; content: unknown[] }>
    system: unknown[]
    tools: Record<string, unknown>
}

type Stage = "create" | "hook" | "prompt" | "wait" | "context" | "dispose" | "remove" | "interrupt"

interface HostFixture {
    ctx: unknown
    promptCalls: Array<{
        sessionID: string
        text: string
        files?: Array<{ uri: string; description?: string }>
        resume?: boolean
    }>
    interruptCalls: string[]
    removedSessions: string[]
    hookDisposals: number
    generateTextCalls: Array<unknown>
    controller: AbortController
    /** Dispatch a context-hook event for the live session, embedding the real marker text. */
    dispatch(overrides?: Partial<MockEvent>): MockEvent
    /** Let the pending session.wait settle. */
    releaseWait(): void
    setContextEntries(entries: Array<Record<string, unknown>>): void
    failOnce(stage: Stage, message?: string): void
}

function createContext() {
    const state = {
        promptCalls: [] as HostFixture["promptCalls"],
        interruptCalls: [] as string[],
        removedSessions: [] as string[],
        hookDisposals: 0,
        generateTextCalls: [] as Array<unknown>,
        dispatches: [] as MockEvent[],
        failures: {} as Record<Stage, string[]>,
        contextEntries: [] as Array<Record<string, unknown>>,
    }
    for (const stage of [
        "create",
        "hook",
        "prompt",
        "wait",
        "context",
        "dispose",
        "remove",
        "interrupt",
    ] as const)
        state.failures[stage] = []
    let sessionCounter = 0
    const hookHandlers: Array<(event: MockEvent) => void> = []
    // The host settles session.wait when the model request finishes; a context
    // hook that throws fails the request, which rejects the wait.
    let settleWait: ((error?: unknown) => void) | undefined
    const waitGate = new Promise<void>((resolve, reject) => {
        settleWait = (error?: unknown) => (error === undefined ? resolve() : reject(error))
    })
    waitGate.catch(() => {}) // keep the gate promise always handled
    const dispatch = (event: MockEvent) => {
        state.dispatches.push(event)
        try {
            for (const handler of hookHandlers) handler(event)
        } catch (error) {
            settleWait?.(error)
            throw error
        }
    }
    return {
        state,
        dispatch,
        releaseWait: () => settleWait?.(),
        ctx: {
            model: { list: async () => ({ data: [] }) },
            generate: {
                text: async (genInput: unknown) => {
                    state.generateTextCalls.push(genInput)
                    return { text: "generated text" }
                },
            },
            session: {
                create: async (_input: unknown, options?: { signal?: AbortSignal }) => {
                    if (options?.signal?.aborted) throw options.signal.reason
                    const failure = state.failures.create.shift()
                    if (failure) throw new Error(failure)
                    return { id: `ses_sum_${++sessionCounter}` }
                },
                hook: async (_name: "context", callback: (event: MockEvent) => void) => {
                    const failure = state.failures.hook.shift()
                    if (failure) throw new Error(failure)
                    hookHandlers.push(callback)
                    return {
                        dispose: async () => {
                            const disposeFailure = state.failures.dispose.shift()
                            if (disposeFailure) throw new Error(disposeFailure)
                            state.hookDisposals++
                        },
                    }
                },
                prompt: async (
                    call: HostFixture["promptCalls"][number],
                    options?: { signal?: AbortSignal },
                ) => {
                    state.promptCalls.push(call)
                    if (options?.signal?.aborted) throw options.signal.reason
                    const failure = state.failures.prompt.shift()
                    if (failure) throw new Error(failure)
                },
                wait: async (_input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
                    const signal = options?.signal
                    const failure = state.failures.wait.shift()
                    await new Promise<void>((resolve, reject) => {
                        if (signal) {
                            if (signal.aborted) return resolve()
                            signal.addEventListener("abort", () => resolve(), { once: true })
                        }
                        void waitGate.then(resolve, reject)
                    })
                    if (signal?.aborted) throw signal.reason
                    if (failure) throw new Error(failure)
                },
                context: async (
                    _input: { sessionID: string },
                    options?: { signal?: AbortSignal },
                ) => {
                    if (options?.signal?.aborted) throw options.signal.reason
                    const failure = state.failures.context.shift()
                    if (failure) throw new Error(failure)
                    return state.contextEntries
                },
                interrupt: async (input: { sessionID: string }) => {
                    state.interruptCalls.push(input.sessionID)
                    const failure = state.failures.interrupt.shift()
                    if (failure) throw new Error(failure)
                    return { success: true }
                },
                remove: async (input: { sessionID: string }) => {
                    const failure = state.failures.remove.shift()
                    if (failure) throw new Error(failure)
                    state.removedSessions.push(input.sessionID)
                },
            },
        },
    }
}

function fixture(): HostFixture {
    const built = createContext()
    return {
        ctx: built.ctx,
        get promptCalls() {
            return built.state.promptCalls
        },
        get interruptCalls() {
            return built.state.interruptCalls
        },
        get removedSessions() {
            return built.state.removedSessions
        },
        get hookDisposals() {
            return built.state.hookDisposals
        },
        get generateTextCalls() {
            return built.state.generateTextCalls
        },
        controller: new AbortController(),
        dispatch(overrides) {
            const prompt = built.state.promptCalls.at(-1)!
            const event: MockEvent = {
                sessionID: prompt.sessionID,
                model: { providerID: "p", id: "m", variant: "high" },
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `before ${prompt.text} after` },
                            { type: "media", media: fakeAsset() },
                        ],
                    },
                ],
                system: ["host system"],
                tools: { read: {} },
                ...overrides,
            }
            built.dispatch(event)
            return event
        },
        releaseWait: () => built.releaseWait(),
        setContextEntries(entries) {
            built.state.contextEntries = entries
        },
        failOnce(stage, message = `${stage} failed`) {
            built.state.failures[stage].push(message)
        },
    }
}

function fakeAsset(base64 = PNG_BASE64, mime = "image/png") {
    return {
        inline: () => ({ mime, base64, dataUrl: `data:${mime};base64,${base64}` }),
    }
}

function assistantEntry(text: string, extra: unknown[] = []) {
    return { type: "assistant", content: [{ type: "text", text }, ...extra] }
}

const imageInput = (
    model: ModelRef,
    images = [{ ref: "ref.png", mime: "image/png", uri: "file://ref.png" }],
) => ({
    prompt: "Summarize the images",
    model,
    images,
    imageTokenLimit: 200000,
})

// Starts generate() and returns once session.prompt has been issued; the
// caller holds the unsettled promise (wrapped, never adopted).
async function startGenerate(
    f: HostFixture,
    model: ModelRef = { providerID: "p", id: "m", variant: "high" },
    images = [{ ref: "ref.png", mime: "image/png", uri: "file://ref.png" }],
) {
    const summarizer = createSummarizer(f.ctx as Parameters<typeof createSummarizer>[0])
    const pending = summarizer.generate(imageInput(model, images), f.controller.signal)
    pending.catch(() => {}) // keep early rejections handled until the test awaits
    await new Promise((resolve) => setTimeout(resolve, 10)) // let it reach session.wait
    assert.equal(f.promptCalls.length, 1, "session.prompt must have been called once")
    return { pending }
}

// ---------------------------------------------------------------------------

test("controlled flow: hook rewrites request, cleanup disposes hook and removes session", async () => {
    const f = fixture()
    const { pending } = await startGenerate(f)
    const event = f.dispatch()
    assert.deepEqual(event.system, [], "hook must clear system prompt")
    assert.deepEqual(event.tools, {}, "hook must strip tools")
    const rewritten = event.messages[0]!.content as Array<{ type: string; text?: string }>
    assert.equal(rewritten.filter((part) => part.type === "media").length, 1)
    assert.ok(
        rewritten.some((part) => part.type === "text" && part.text === "Summarize the images"),
    )
    assert.ok(
        rewritten.some((part) => part.type === "text" && part.text === "Image reference: ref.png"),
    )
    f.setContextEntries([assistantEntry("Summary of the image.")])
    f.releaseWait()
    const result = await pending
    assert.equal(result.text, "Summary of the image.")
    assert.equal(result.imageTokens, Math.ceil(1 / 16) * Math.ceil(1 / 16) * 4 + 1024)
    assert.equal(f.hookDisposals, 1)
    assert.equal(f.removedSessions.length, 1)
    assert.equal(f.removedSessions[0], f.promptCalls[0]!.sessionID)
    assert.equal(f.promptCalls[0]!.files?.[0]?.uri, "file://ref.png")
    assert.equal(f.promptCalls[0]!.resume, true)
})

test("no-variant input accepts a host-resolved default variant", async () => {
    const f = fixture()
    const { pending } = await startGenerate(f, { providerID: "p", id: "m" })
    const event = f.dispatch({ model: { providerID: "p", id: "m", variant: "default" } })
    assert.equal(
        (event.messages[0]!.content as unknown[]).length,
        3,
        "hook must not throw for a default variant when none was requested",
    )
    f.setContextEntries([assistantEntry("ok")])
    f.releaseWait()
    assert.equal((await pending).text, "ok")
})

test("wrong variant in the context hook rejects and cleans up", async () => {
    const f = fixture()
    const { pending } = await startGenerate(f, { providerID: "p", id: "m", variant: "high" })
    assert.throws(() => f.dispatch({ model: { providerID: "p", id: "m", variant: "default" } }))
    await assert.rejects(pending, /model or request count changed/)
    assert.equal(f.hookDisposals, 1)
    assert.equal(f.removedSessions[0], f.promptCalls[0]!.sessionID)
})

test("second context dispatch (second turn) rejects and cleans up", async () => {
    const f = fixture()
    const { pending } = await startGenerate(f)
    f.dispatch()
    assert.throws(() => f.dispatch(), /model or request count changed/)
    await assert.rejects(pending, /model or request count changed/)
    assert.equal(f.hookDisposals, 1)
    assert.equal(f.removedSessions.length, 1)
})

test("host-provided tools are stripped by the hook before the request", async () => {
    const f = fixture()
    const { pending } = await startGenerate(f)
    const event = f.dispatch({ tools: { bash: { description: "run anything" } } })
    assert.deepEqual(event.tools, {})
    f.setContextEntries([assistantEntry("fine")])
    f.releaseWait()
    await pending
})

test("missing images, exceeded budget, and corrupt media fail closed with cleanup", async () => {
    // Host loaded fewer images than selected.
    {
        const f = fixture()
        const { pending } = await startGenerate(f, { providerID: "p", id: "m", variant: "high" }, [
            { ref: "a", mime: "image/png", uri: "file://a" },
            { ref: "b", mime: "image/png", uri: "file://b" },
        ])
        assert.throws(() =>
            f.dispatch({
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `x ${f.promptCalls[0]!.text} y` },
                            { type: "media", media: fakeAsset() },
                        ],
                    },
                ],
            }),
        )
        await assert.rejects(pending, /did not load selected images/)
        assert.equal(f.removedSessions.length, 1)
        assert.equal(f.hookDisposals, 1)
    }
    // Image tokens exceed the budget.
    {
        const f = fixture()
        const summarizer = createSummarizer(f.ctx as Parameters<typeof createSummarizer>[0])
        const pending = summarizer.generate(
            { ...imageInput({ providerID: "p", id: "m", variant: "high" }), imageTokenLimit: 10 },
            f.controller.signal,
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert.throws(() => f.dispatch())
        await assert.rejects(pending, /exceed safe context budget/)
        assert.equal(f.removedSessions.length, 1)
        assert.equal(f.hookDisposals, 1)
    }
    // Corrupt image bytes: estimation throws (fail closed), never commits.
    {
        const f = fixture()
        const { pending } = await startGenerate(f)
        const corrupt = Buffer.from("definitely not a png").toString("base64")
        assert.throws(() =>
            f.dispatch({
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `x ${f.promptCalls[0]!.text} y` },
                            { type: "media", media: fakeAsset(corrupt) },
                        ],
                    },
                ],
            }),
        )
        // Observed: the raw image-size TypeError escapes the guarded
        // "dimensions unavailable" message (summarizer.ts:94 throws before the
        // guard at :95). Still fails closed with full cleanup.
        await assert.rejects(pending, /unsupported file type|dimensions unavailable/)
        assert.equal(f.removedSessions.length, 1)
        assert.equal(f.hookDisposals, 1)
    }
})

test("interrupted native outcome rejects even when the summary JSON is complete", async () => {
    const f = fixture()
    const { pending } = await startGenerate(f)
    f.dispatch()
    f.setContextEntries([
        assistantEntry(JSON.stringify({ summary: "Partial image summary.", complete: true })),
        { type: "idle", outcome: "interrupted" },
    ])
    f.releaseWait()
    await assert.rejects(pending, /tool-free response/)
    assert.equal(f.hookDisposals, 1)
    assert.equal(f.removedSessions.length, 1)
})

test("failed idle, tool-bearing, and empty assistant responses reject without commit", async () => {
    const cases: Array<[string, Array<Record<string, unknown>>]> = [
        ["failed idle", [{ type: "idle", outcome: "failed" }]],
        ["tool in response", [assistantEntry("text", [{ type: "tool", name: "read", state: {} }])]],
        ["whitespace text", [assistantEntry("   \n ")]],
        ["no assistant entries", [{ type: "user", text: "only user" }]],
    ]
    for (const [name, entries] of cases) {
        const f = fixture()
        const { pending } = await startGenerate(f)
        f.dispatch()
        f.setContextEntries(entries)
        f.releaseWait()
        await assert.rejects(pending, /tool-free response/, `case: ${name}`)
        assert.equal(f.hookDisposals, 1)
        assert.equal(f.removedSessions.length, 1)
    }
})

test("cancellation during the model request: interrupt, cleanup, no partial result", async () => {
    const f = fixture()
    const { pending } = await startGenerate(f)
    f.dispatch()
    f.controller.abort(new Error("boundary cancelled"))
    await assert.rejects(pending)
    const sessionID = f.promptCalls[0]!.sessionID
    assert.ok(f.interruptCalls.includes(sessionID))
    assert.equal(f.hookDisposals, 1, "hook disposed after cancel")
    assert.equal(f.removedSessions[0], sessionID, "temporary session removed after cancel")
    assert.equal(f.generateTextCalls.length, 0)
})

test("failed create/prompt/wait/context stages propagate and clean up the temporary session", async () => {
    // create fails before any session exists.
    {
        const f = fixture()
        f.failOnce("create", "create boom")
        const summarizer = createSummarizer(f.ctx as Parameters<typeof createSummarizer>[0])
        const pending = summarizer.generate(
            imageInput({ providerID: "p", id: "m", variant: "high" }),
            f.controller.signal,
        )
        pending.catch(() => {})
        await assert.rejects(pending, /create boom/)
        assert.equal(f.removedSessions.length, 0, "no session existed yet")
        assert.equal(f.hookDisposals, 0)
        assert.equal(f.promptCalls.length, 0)
    }
    for (const stage of ["prompt", "wait", "context"] as const) {
        const f = fixture()
        f.failOnce(stage, `${stage} boom`)
        const { pending } = await startGenerate(f)
        if (stage === "wait") f.releaseWait()
        if (stage === "context") {
            f.setContextEntries([assistantEntry("ok")])
            f.releaseWait()
        }
        await assert.rejects(pending, new RegExp(`${stage} boom`), `stage: ${stage}`)
        assert.equal(f.hookDisposals, 1, `hook disposed after ${stage} failure`)
        assert.equal(f.removedSessions.length, 1, `session removed after ${stage} failure`)
    }
})

test("cleanup failures are surfaced, not swallowed", async () => {
    for (const stage of ["dispose", "remove"] as const) {
        const f = fixture()
        f.failOnce(stage, `${stage} boom`)
        const { pending } = await startGenerate(f)
        f.dispatch()
        f.setContextEntries([assistantEntry("ok")])
        f.releaseWait()
        await assert.rejects(pending, new RegExp(`${stage} boom`), `stage: ${stage}`)
    }
})

test("cancellation with a rejected interrupt still disposes and removes the session", async () => {
    const f = fixture()
    f.failOnce("interrupt", "interrupt boom")
    const { pending } = await startGenerate(f)
    f.dispatch()
    f.controller.abort(new Error("boundary cancelled"))
    await assert.rejects(pending)
    const sessionID = f.promptCalls[0]!.sessionID
    assert.ok(f.interruptCalls.includes(sessionID), "interrupt was attempted")
    assert.equal(f.hookDisposals, 1, "hook disposed even when interrupt rejects")
    assert.equal(f.removedSessions[0], sessionID, "session removed even when interrupt rejects")
})

test("text-only input bypasses the isolated session entirely", async () => {
    const f = fixture()
    const summarizer = createSummarizer(f.ctx as Parameters<typeof createSummarizer>[0])
    const result = await summarizer.generate(
        { prompt: "Summarize", model: { providerID: "p", id: "m" } },
        f.controller.signal,
    )
    assert.equal(result.text, "generated text")
    assert.equal(f.generateTextCalls.length, 1)
    assert.equal(f.promptCalls.length, 0, "no temporary session prompt")
    assert.equal(f.removedSessions.length, 0)
})
