// Lifecycle, exactness and responsiveness regressions for the killable tokenizer child.
// Runs the shipped lib/ sidecars offline with no model or network access.
import assert from "node:assert/strict"
import test from "node:test"
import { spawn, spawnSync } from "node:child_process"
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { countTokens as oracle } from "@anthropic-ai/tokenizer"
import { TokenCounter, TokenCountError } from "../lib/token-counter"

const sidecars = fileURLToPath(new URL("../lib/tokenizer/", import.meta.url))
// TypeScript test hosts run under tsx on Node; Bun runs them directly.
const tsHost = (host: string) => (process.versions.bun ? [host] : ["--import", "tsx", host])
const PATHOLOGICAL = "a".repeat(500_000)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid: number | undefined): boolean {
    if (!pid || !existsSync(`/proc/${pid}`)) return false
    try {
        return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    } catch {
        return false
    }
}

async function waitGone(pid: number | undefined, ms = 3000): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (!alive(pid)) return true
        await sleep(20)
    }
    return !alive(pid)
}

function heartbeat() {
    let last = performance.now()
    let maxGap = 0
    const timer = setInterval(() => {
        const now = performance.now()
        maxGap = Math.max(maxGap, now - last)
        last = now
    }, 25)
    return () => {
        clearInterval(timer)
        return maxGap
    }
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof TokenCountError, String(error))
        assert.equal(error.code, code)
        return true
    })
}

function childArgs(script: string, dir: string, maxTextLength = 1024 * 1024) {
    return process.versions.bun
        ? [
              "--no-env-file",
              "--no-install",
              `--config=${dir}tokenizer-runtime.bunfig.toml`,
              script,
              String(maxTextLength),
          ]
        : [script, String(maxTextLength)]
}

function fakeSidecar(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "dcp-fake-sidecar-")) + "/"
    // CommonJS regardless of any enclosing package.json.
    writeFileSync(dir + "package.json", '{"type":"commonjs"}')
    copyFileSync(
        join(sidecars, "tokenizer-runtime.bunfig.toml"),
        dir + "tokenizer-runtime.bunfig.toml",
    )
    writeFileSync(
        dir + "tokenizer-child.js",
        `const readline = require("node:readline")
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
${source}
`,
    )
    return dir
}

const READY = `say({ ready: 1, protocol: "dcp-tokenizer/1", runtime: "fake" })`
const ON_LINE = (body: string) =>
    `readline.createInterface({ input: process.stdin }).on("line", (line) => { const m = JSON.parse(line); ${body} })`

test("counts match @anthropic-ai/tokenizer exactly and reuse one child", async () => {
    const counter = new TokenCounter()
    const fixtures = [
        "",
        "hello world",
        "Ｈｅｌｌｏ ﬁ ①", // NFKC-sensitive
        "emoji 👩‍👩‍👧‍👦 and flags 🇬🇧",
        "lone surrogate \ud800 end",
        "<EOT> <|endoftext|> special-looking text",
        ["first part", "second part"].join("\n"),
        "investigate ".repeat(2000),
        "Ünïcödé — “quotes” ‘and’ 日本語テキスト",
    ]
    try {
        let pid: number | undefined
        for (const text of fixtures) {
            assert.equal(await counter.count(text), oracle(text), JSON.stringify(text.slice(0, 40)))
            pid ??= counter.stats.pid
            assert.equal(counter.stats.pid, pid)
        }
    } finally {
        await counter.dispose()
    }
})

test("many modest messages stay exact without blocking the event loop", async () => {
    const counter = new TokenCounter()
    // Each count pays the tokenizer's per-call setup (tens of milliseconds), as before.
    const texts = Array.from(
        { length: 40 },
        (_, i) => `message ${i}: ` + `entry ${i} of the log `.repeat(100 + i),
    )
    const stop = heartbeat()
    try {
        const counts = await Promise.all(texts.map((text) => counter.count(text)))
        const maxGap = stop()
        assert.deepEqual(
            counts,
            texts.map((text) => oracle(text)),
        )
        assert.ok(maxGap < 250, `max heartbeat gap ${maxGap}ms`)
    } finally {
        stop()
        await counter.dispose()
    }
})

test("pathological input times out, kills the child, keeps the loop responsive and recovers", async () => {
    const counter = new TokenCounter({ jobTimeoutMs: 1000, killMarginMs: 300 })
    const stop = heartbeat()
    try {
        assert.equal(await counter.count("warm up"), oracle("warm up"))
        const pid = counter.stats.pid
        const started = performance.now()
        await rejectsWith(counter.count(PATHOLOGICAL), "timeout")
        const elapsed = performance.now() - started
        assert.ok(elapsed < 2500, `timeout took ${elapsed}ms`)
        assert.ok(await waitGone(pid), "timed-out child still running")
        assert.ok(stop() < 250, "event loop stalled")
        assert.equal(await counter.count("hello again"), oracle("hello again"))
        assert.notEqual(counter.stats.pid, pid)
    } finally {
        stop()
        await counter.dispose()
    }
})

test("queued jobs survive a timeout of the active job", async () => {
    const counter = new TokenCounter({ jobTimeoutMs: 800, killMarginMs: 200 })
    try {
        const slow = counter.count(PATHOLOGICAL)
        const next = counter.count("after the slow one")
        await rejectsWith(slow, "timeout")
        assert.equal(await next, oracle("after the slow one"))
    } finally {
        await counter.dispose()
    }
})

test("bounded queue: too large, full and queue timeout are rejected without counting", async () => {
    const small = new TokenCounter({ maxTextLength: 10, maxQueuedJobs: 1 })
    try {
        await rejectsWith(small.count("x".repeat(11)), "too_large")
        const first = small.count("queued")
        await rejectsWith(small.count("second"), "queue_full")
        assert.equal(await first, oracle("queued"))
    } finally {
        await small.dispose()
    }

    const hung = new TokenCounter(
        { queueTimeoutMs: 150, startupTimeoutMs: 5000 },
        fakeSidecar(`setInterval(() => {}, 1000); process.stdin.resume()`),
    )
    try {
        await rejectsWith(hung.count("never dispatched"), "queue_timeout")
        assert.equal(hung.stats.queued, 0)
        assert.equal(hung.stats.queuedTextLength, 0)
    } finally {
        await hung.dispose()
    }
})

test("dispose rejects running and queued jobs and kills the child", async () => {
    const counter = new TokenCounter({ jobTimeoutMs: 30_000 })
    await counter.count("start")
    const pid = counter.stats.pid
    const running = counter.count(PATHOLOGICAL)
    const queued = counter.count("queued")
    const settled = Promise.all([rejectsWith(running, "disposed"), rejectsWith(queued, "disposed")])
    await sleep(200)
    await counter.dispose()
    await settled
    assert.ok(await waitGone(pid))
    await rejectsWith(counter.count("after"), "disposed")
})

test("idle child is torn down and does not hold the host open", async () => {
    const counter = new TokenCounter({ idleTimeoutMs: 200 })
    try {
        await counter.count("idle soon")
        const pid = counter.stats.pid
        assert.ok(alive(pid))
        await sleep(600)
        assert.equal(counter.stats.pid, undefined)
        assert.ok(await waitGone(pid))
        assert.equal(await counter.count("restart"), oracle("restart"))
    } finally {
        await counter.dispose()
    }
})

test("child receives a minimal environment and no text in argv", async () => {
    process.env.DCP_POISON_SECRET = "poison-value"
    const counter = new TokenCounter()
    try {
        await counter.count("zz-private-marker-zz")
        const pid = counter.stats.pid!
        const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean)
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        assert.ok(!environ.some((entry) => entry.includes("poison-value")))
        assert.ok(
            !environ.some((entry) =>
                /^(HOME|PATH|NODE_OPTIONS|BUN_INSPECT|BUN_OPTIONS)=/.test(entry),
            ),
        )
        assert.ok(!cmdline.includes("zz-private-marker-zz"))
    } finally {
        delete process.env.DCP_POISON_SECRET
        await counter.dispose()
    }
})

test("malformed sidecars fail closed without fallback counts", async () => {
    const cases: Array<[string, string, string]> = [
        ["missing", "", "unavailable"],
        [
            "stdout noise",
            `process.stdout.write("hello\\n"); ${READY}; process.stdin.resume()`,
            "unavailable",
        ],
        [
            "wrong protocol",
            `say({ ready: 1, protocol: "other" }); process.stdin.resume()`,
            "unavailable",
        ],
        ["wrong id", `${READY}; ${ON_LINE("say({ id: m.id + 1, count: 1 })")}`, "protocol"],
        ["bad count", `${READY}; ${ON_LINE("say({ id: m.id, count: -1 })")}`, "protocol"],
        [
            "oversized line",
            `${READY}; ${ON_LINE('process.stdout.write("x".repeat(10000))')}`,
            "protocol",
        ],
        ["crash", `${READY}; ${ON_LINE("process.exit(1)")}`, "crashed"],
        ["no ready", `process.stdin.resume()`, "unavailable"],
    ]
    for (const [name, source, code] of cases) {
        const dir =
            name === "missing"
                ? mkdtempSync(join(tmpdir(), "dcp-missing-")) + "/"
                : fakeSidecar(source)
        const counter = new TokenCounter({ startupTimeoutMs: 1000, jobTimeoutMs: 1000 }, dir)
        try {
            await rejectsWith(counter.count("text"), code)
        } finally {
            await counter.dispose()
        }
    }
})

test("child supervisor kills itself on its own deadline and on stdin loss", async () => {
    for (const mode of ["deadline", "stdin"]) {
        const child = spawn(
            process.execPath,
            childArgs(join(sidecars, "tokenizer-child.js"), sidecars),
            {
                cwd: sidecars,
                env: process.versions.bun ? { BUN_BE_BUN: "1" } : {},
                stdio: ["pipe", "pipe", "ignore"],
            },
        )
        const exited = new Promise<string | null>((resolve) =>
            child.on("exit", (_code, signal) => resolve(signal)),
        )
        await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()))
        const started = performance.now()
        if (mode === "deadline")
            child.stdin!.write(
                JSON.stringify({ id: 1, text: PATHOLOGICAL, deadlineMs: 300 }) + "\n",
            )
        else child.stdin!.end()
        const signal = await Promise.race([exited, sleep(5000).then(() => "still running")])
        if (signal === "still running") child.kill("SIGKILL")
        assert.equal(signal, "SIGKILL", mode)
        assert.ok(performance.now() - started < 3000, mode)
    }
})

test("child dies when its parent host is SIGKILLed mid-count", async () => {
    const counterPath = fileURLToPath(new URL("../lib/token-counter.ts", import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), "dcp-parent-kill-"))
    const host = join(dir, "host.ts")
    writeFileSync(
        host,
        `import { TokenCounter } from ${JSON.stringify(counterPath)}
const counter = new TokenCounter({ jobTimeoutMs: 60000 })
await counter.count("ready")
counter.count("a".repeat(500000)).catch(() => {})
console.log(counter.stats.pid)
setInterval(() => {}, 1000)
`,
    )
    const parent = spawn(process.execPath, tsHost(host), {
        env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() },
        stdio: ["ignore", "pipe", "inherit"],
    })
    const pid = Number(
        await new Promise<string>((resolve) =>
            parent.stdout!.once("data", (data) => resolve(String(data))),
        ),
    )
    assert.ok(alive(pid))
    await sleep(200)
    parent.kill("SIGKILL")
    assert.ok(await waitGone(pid, 3000), "orphaned tokenizer child kept running")
})

test("failed or disposed startup leaves no timer holding the host open", async () => {
    const counterPath = fileURLToPath(new URL("../lib/token-counter.ts", import.meta.url))
    const cases: Array<[string, string]> = [
        ["hung then disposed", "process.stdin.resume()"],
        ["missing", ""],
        ["crash before ready", "process.exit(1)"],
        ["invalid handshake", `say({ ready: 1, protocol: "other" }); process.stdin.resume()`],
    ]
    for (const [name, source] of cases) {
        const dir =
            name === "missing"
                ? mkdtempSync(join(tmpdir(), "dcp-missing-")) + "/"
                : fakeSidecar(source)
        const host = join(mkdtempSync(join(tmpdir(), "dcp-startup-host-")), "host.ts")
        // No process.exit: the host must end on its own once the counter is finished.
        writeFileSync(
            host,
            `import { TokenCounter } from ${JSON.stringify(counterPath)}
const counter = new TokenCounter({ startupTimeoutMs: 8000, queueTimeoutMs: 100 }, ${JSON.stringify(dir)})
await counter.count("synthetic").catch(() => {})
await counter.dispose()
`,
        )
        const started = performance.now()
        const parent = spawn(process.execPath, tsHost(host), {
            env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() },
            stdio: ["ignore", "ignore", "inherit"],
        })
        const code = await Promise.race([
            new Promise<number | null>((resolve) =>
                parent.on("exit", (exitCode) => resolve(exitCode)),
            ),
            sleep(6000).then(() => "still running"),
        ])
        if (code === "still running") parent.kill("SIGKILL")
        assert.equal(code, 0, name)
        assert.ok(performance.now() - started < 4000, `${name} host held open`)
    }
})

test("child supervisor bounds raw input during startup, active work and framing", async () => {
    const maxTextLength = 1000
    const cap = maxTextLength * 6 + 256
    const frame = (id: number, text: string, deadlineMs = 3000) =>
        JSON.stringify({ id, text, deadlineMs }) + "\n"
    const run = async (
        act: (stdin: NodeJS.WritableStream, ready: Promise<void>) => Promise<void>,
        limit = maxTextLength,
    ) => {
        const child = spawn(
            process.execPath,
            childArgs(join(sidecars, "tokenizer-child.js"), sidecars, limit),
            {
                cwd: sidecars,
                env: process.versions.bun ? { BUN_BE_BUN: "1" } : {},
                stdio: ["pipe", "pipe", "ignore"],
            },
        )
        const lines: string[] = []
        let buffer = ""
        child.stdout!.setEncoding("utf8")
        child.stdout!.on("data", (chunk: string) => {
            buffer += chunk
            let newline: number
            while ((newline = buffer.indexOf("\n")) !== -1) {
                lines.push(buffer.slice(0, newline))
                buffer = buffer.slice(newline + 1)
            }
        })
        const ready = new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()))
        const exited = new Promise<string | null>((resolve) =>
            child.on("exit", (_code, signal) => resolve(signal)),
        )
        child.stdin!.on("error", () => {})
        await act(child.stdin!, ready)
        const signal = await Promise.race([exited, sleep(2000).then(() => "still running")])
        if (signal === "still running") {
            child.kill("SIGKILL")
            await exited
        }
        return { signal, lines }
    }
    // Any byte before readiness is a protocol error.
    let result = await run(async (stdin) => void stdin.write("x"))
    assert.equal(result.signal, "SIGKILL", "startup input")
    // Any byte while a job is running is rejected at once, not retained until the deadline.
    result = await run(async (stdin, ready) => {
        await ready
        stdin.write(frame(1, PATHOLOGICAL, 60000))
        await sleep(200)
        stdin.write("y")
    }, PATHOLOGICAL.length)
    assert.equal(result.signal, "SIGKILL", "input during active job")
    // A partial frame beyond the byte bound is rejected before it is retained.
    result = await run(async (stdin, ready) => {
        await ready
        stdin.write("z".repeat(cap + 2))
    })
    assert.equal(result.signal, "SIGKILL", "oversized partial frame")
    // A frame coalesced with following bytes is rejected.
    result = await run(async (stdin, ready) => {
        await ready
        stdin.write(frame(1, "one") + frame(2, "two"))
    })
    assert.equal(result.signal, "SIGKILL", "coalesced frames")
    // A full frame split across writes within the bound is counted exactly; then idle input is accepted.
    result = await run(async (stdin, ready) => {
        await ready
        const whole = frame(1, "hello world")
        stdin.write(whole.slice(0, 5))
        await sleep(20)
        stdin.write(whole.slice(5))
        await sleep(500)
        stdin.end()
    })
    assert.ok(
        result.lines.includes(JSON.stringify({ id: 1, count: oracle("hello world") })),
        result.lines.join("|"),
    )
})

test("an ancestor project's tsconfig and bunfig cannot redirect the tokenizer", async () => {
    // A package installed inside a project whose config aliases the tokenizer and preloads code.
    const root = mkdtempSync(join(tmpdir(), "dcp-ancestor-config-"))
    writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                baseUrl: ".",
                paths: { "@anthropic-ai/tokenizer": ["./poison-tokenizer.js"] },
            },
        }),
    )
    writeFileSync(
        join(root, "poison-tokenizer.js"),
        `import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(join(root, "poison-ran"))}, "")
export const countTokens = () => 424242
export default { countTokens }
`,
    )
    writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.js"]\n')
    writeFileSync(
        join(root, "preload.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(join(root, "preload-ran"))}, "")\n`,
    )
    const lib = join(root, "node_modules", "dcp", "lib")
    mkdirSync(lib, { recursive: true })
    cpSync(sidecars, join(lib, "tokenizer"), { recursive: true })
    copyFileSync(
        fileURLToPath(new URL("../lib/token-counter.ts", import.meta.url)),
        join(lib, "token-counter.ts"),
    )
    writeFileSync(join(root, "node_modules", "dcp", "package.json"), '{"type":"module"}')
    symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(root, "node_modules", "dcp", "node_modules"),
    )
    const text = "hello world"
    const hostDir = mkdtempSync(join(tmpdir(), "dcp-ancestor-host-"))
    const host = join(hostDir, "host.ts")
    writeFileSync(
        host,
        `import { TokenCounter } from ${JSON.stringify(join(lib, "token-counter.ts"))}
const counter = new TokenCounter()
console.log(await counter.count(${JSON.stringify(text)}))
await counter.dispose()
`,
    )
    // Bun is the runtime that applies tsconfig paths; also check it when testing under Node.
    const runtimes: string[][] = [[process.execPath, ...tsHost(host)]]
    if (!process.versions.bun && spawnSync("bun", ["--version"]).status === 0)
        runtimes.push(["bun", host])
    for (const [runtime, ...args] of runtimes) {
        const result = spawnSync(runtime, args, {
            // The repository (no bunfig) lets Node resolve tsx; the child's cwd is its own directory.
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() },
            encoding: "utf8",
            timeout: 30000,
        })
        assert.equal(result.status, 0, `${runtime}: ${result.stderr}`)
        assert.equal(Number(result.stdout.trim()), oracle(text), runtime)
    }
    assert.equal(existsSync(join(root, "poison-ran")), false, "aliased tokenizer was loaded")
    assert.equal(existsSync(join(root, "preload-ran")), false, "ancestor preload ran")
})
