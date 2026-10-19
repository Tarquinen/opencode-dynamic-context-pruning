// Exact token counting in a killable child process.
//
// The tokenizer's WASM can take minutes on some inputs (for example long
// runs of one character) and Bun cannot interrupt a worker executing it, so
// counting runs in one child process (lib/tokenizer/tokenizer-child.js, which contains a
// tokenizer worker). The host event loop never encodes. A job that exceeds its
// deadline is stopped by killing the child at the OS level; the child also kills
// itself on its own deadline or when its parent disappears. Failures reject with
// TokenCountError: counts are never guessed, truncated or approximated.
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

const PROTOCOL = "dcp-tokenizer/1"

export type TokenCountErrorCode =
    | "too_large"
    | "queue_full"
    | "queue_timeout"
    | "timeout"
    | "unavailable"
    | "protocol"
    | "crashed"
    | "encode"
    | "disposed"

export class TokenCountError extends Error {
    constructor(readonly code: TokenCountErrorCode) {
        super(`DCP token counting failed: ${code}`)
        this.name = "TokenCountError"
    }
}

export interface TokenCounterLimits {
    /** Largest accepted text, in UTF-16 code units. Larger text is rejected, never truncated. */
    maxTextLength: number
    /** Maximum queued (not yet dispatched) jobs. */
    maxQueuedJobs: number
    /** Maximum aggregate queued text, in UTF-16 code units. */
    maxQueuedTextLength: number
    /** Maximum time a job may wait in the queue before dispatch. */
    queueTimeoutMs: number
    /** Child process startup and handshake deadline. */
    startupTimeoutMs: number
    /** Active counting deadline; the child kills itself when it expires. */
    jobTimeoutMs: number
    /** Extra parent-side allowance beyond the child's own deadline before the parent kills it. */
    killMarginMs: number
    /** Time allowed for a killed child to be reaped before the service stays unavailable. */
    reapTimeoutMs: number
    /** Idle time after which the child is shut down. */
    idleTimeoutMs: number
}

export const DEFAULT_TOKEN_COUNTER_LIMITS: TokenCounterLimits = {
    maxTextLength: 8 * 1024 * 1024,
    maxQueuedJobs: 1024,
    maxQueuedTextLength: 32 * 1024 * 1024,
    queueTimeoutMs: 30_000,
    startupTimeoutMs: 10_000,
    jobTimeoutMs: 5_000,
    killMarginMs: 500,
    reapTimeoutMs: 2_000,
    idleTimeoutMs: 30_000,
}

const MAX_RESPONSE_LINE = 4096

interface Job {
    id: number
    text: string | undefined
    resolve: (count: number) => void
    reject: (error: TokenCountError) => void
    queueTimer?: ReturnType<typeof setTimeout>
}

// The sidecars ship as plain JS in lib/tokenizer/, beside their own Bun config and an empty
// tsconfig.json that stops Bun applying an ancestor project's path aliases to the child.
// This resolves from both lib/token-counter.ts and dist/index.js.
function sidecarDir(): string {
    return fileURLToPath(new URL("../lib/tokenizer/", import.meta.url))
}

function launch(dir: string, maxTextLength: number): ChildProcess {
    const child = `${dir}tokenizer-child.js`
    // Minimal explicit environment: no secrets, preloads, inspectors or CLI flags reach the child.
    const env: Record<string, string> = {
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
    }
    let args: string[]
    if (process.versions.bun) {
        // A compiled Bun host re-executes itself as the Bun CLI only for this child.
        env.BUN_BE_BUN = "1"
        args = [
            "--no-env-file",
            "--no-install",
            `--config=${dir}tokenizer-runtime.bunfig.toml`,
            child,
            String(maxTextLength),
        ]
    } else {
        args = [child, String(maxTextLength)]
    }
    return spawn(process.execPath, args, {
        cwd: dir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    })
}

export class TokenCounter {
    private readonly limits: TokenCounterLimits
    private readonly dir: string
    private queue: Job[] = []
    private queuedTextLength = 0
    private nextId = 0
    private child: ChildProcess | undefined
    private ready = false
    private active: Job | undefined
    private activeTimer: ReturnType<typeof setTimeout> | undefined
    private activeDeadline = Infinity
    private idleTimer: ReturnType<typeof setTimeout> | undefined
    private startupTimer: ReturnType<typeof setTimeout> | undefined
    private reaping: Promise<void> | undefined
    private unavailable = false
    private disposed = false
    private stdout = ""
    private readonly killOnExit = () => this.child?.kill("SIGKILL")

    constructor(limits: Partial<TokenCounterLimits> = {}, dir = sidecarDir()) {
        this.limits = { ...DEFAULT_TOKEN_COUNTER_LIMITS, ...limits }
        this.dir = dir
    }

    /** Exact token count. Rejects with TokenCountError rather than estimating. */
    count(text: string): Promise<number> {
        if (this.disposed) return Promise.reject(new TokenCountError("disposed"))
        if (typeof text !== "string" || text.length > this.limits.maxTextLength)
            return Promise.reject(new TokenCountError("too_large"))
        if (this.unavailable) return Promise.reject(new TokenCountError("unavailable"))
        if (
            this.queue.length >= this.limits.maxQueuedJobs ||
            this.queuedTextLength + text.length > this.limits.maxQueuedTextLength
        )
            return Promise.reject(new TokenCountError("queue_full"))

        return new Promise<number>((resolve, reject) => {
            const job: Job = { id: ++this.nextId, text, resolve, reject }
            job.queueTimer = setTimeout(() => {
                if (!this.remove(job)) return
                reject(new TokenCountError("queue_timeout"))
            }, this.limits.queueTimeoutMs)
            this.queue.push(job)
            this.queuedTextLength += text.length
            this.pump()
        })
    }

    /** Kills any child and rejects every pending job. */
    async dispose(): Promise<void> {
        this.disposed = true
        this.failAll("disposed")
        await this.stopChild()
    }

    /** Test/diagnostic view; never contains text. */
    get stats() {
        return {
            pid: this.child?.pid,
            queued: this.queue.length,
            queuedTextLength: this.queuedTextLength,
            active: this.active !== undefined,
            unavailable: this.unavailable,
        }
    }

    private remove(job: Job): boolean {
        const index = this.queue.indexOf(job)
        if (index === -1) return false
        this.queue.splice(index, 1)
        this.queuedTextLength -= job.text!.length
        clearTimeout(job.queueTimer)
        job.text = undefined
        return true
    }

    private pump(): void {
        if (this.active || this.reaping || this.disposed || this.queue.length === 0) return
        clearTimeout(this.idleTimer)
        this.idleTimer = undefined
        if (!this.child) {
            this.start()
            return
        }
        if (!this.ready) return
        const job = this.queue[0]
        const text = job.text!
        this.remove(job)
        this.active = job
        this.activeDeadline = performance.now() + this.limits.jobTimeoutMs
        const frame =
            JSON.stringify({ id: job.id, text, deadlineMs: this.limits.jobTimeoutMs }) + "\n"
        this.activeTimer = setTimeout(
            () => this.fail("timeout"),
            this.limits.jobTimeoutMs + this.limits.killMarginMs,
        )
        this.setRef(true)
        // Back-pressure is handled by the pipe; the deadline covers slow transfer.
        this.child.stdin!.write(frame)
    }

    private start(): void {
        let child: ChildProcess
        try {
            child = launch(this.dir, this.limits.maxTextLength)
        } catch {
            this.failAll("unavailable")
            return
        }
        this.child = child
        this.ready = false
        this.stdout = ""
        process.on("exit", this.killOnExit)
        // Events from a replaced child are ignored.
        const failed = () => {
            if (this.child !== child) return
            // The child kills itself when the job deadline passes, usually before the parent does.
            if (!this.ready) this.fail("unavailable")
            else this.fail(performance.now() >= this.activeDeadline ? "timeout" : "crashed")
        }
        // Owned by this child: cleared on handshake or whenever the child is stopped.
        this.startupTimer = setTimeout(failed, this.limits.startupTimeoutMs)
        child.on("error", failed)
        child.on("close", failed)
        child.stdin!.on("error", failed)
        // The child never writes text; discard diagnostics without retaining them.
        child.stderr!.resume()
        child.stdout!.setEncoding("utf8")
        child.stdout!.on("data", (chunk: string) => {
            if (this.child !== child) return
            this.stdout += chunk
            let newline: number
            while ((newline = this.stdout.indexOf("\n")) !== -1) {
                const line = this.stdout.slice(0, newline)
                this.stdout = this.stdout.slice(newline + 1)
                if (!this.receive(line)) return
            }
            if (this.stdout.length > MAX_RESPONSE_LINE) this.fail("protocol")
        })
    }

    private receive(line: string): boolean {
        let message: any
        try {
            message = line.length <= MAX_RESPONSE_LINE ? JSON.parse(line) : undefined
        } catch {}
        if (!this.ready) {
            if (message?.ready !== 1 || message.protocol !== PROTOCOL) {
                this.fail("unavailable")
                return false
            }
            clearTimeout(this.startupTimer)
            this.ready = true
            this.pump()
            if (!this.active) this.armIdle()
            return true
        }
        const job = this.active
        if (!job || message?.id !== job.id) {
            this.fail("protocol")
            return false
        }
        if (message.error === "encode") {
            this.finish()
            job.reject(new TokenCountError("encode"))
        } else if (Number.isSafeInteger(message.count) && message.count >= 0) {
            this.finish()
            job.resolve(message.count)
        } else {
            this.fail("protocol")
            return false
        }
        this.pump()
        if (!this.active) this.armIdle()
        return true
    }

    private finish(): void {
        clearTimeout(this.activeTimer)
        this.activeTimer = undefined
        this.activeDeadline = Infinity
        this.active = undefined
    }

    /** An idle child must not keep the host process alive. */
    private setRef(on: boolean): void {
        const child = this.child
        if (!child) return
        for (const handle of [child, child.stdin, child.stdout, child.stderr] as any[])
            on ? handle?.ref?.() : handle?.unref?.()
    }

    private armIdle(): void {
        this.setRef(false)
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => {
            if (!this.active && this.queue.length === 0) void this.stopChild()
        }, this.limits.idleTimeoutMs)
        this.idleTimer.unref?.()
    }

    /** Fails the active job (and queued jobs if the child never started), then replaces the child. */
    private fail(code: TokenCountErrorCode): void {
        const job = this.active
        const startingUp = !this.ready
        this.finish()
        job?.reject(new TokenCountError(code))
        // Queued jobs are retried on a fresh child unless startup itself is failing.
        if (startingUp) this.failAll(code)
        void this.stopChild().then(() => this.pump())
    }

    private failAll(code: TokenCountErrorCode): void {
        for (const job of [...this.queue]) {
            this.remove(job)
            job.reject(new TokenCountError(code))
        }
        const job = this.active
        this.finish()
        job?.reject(new TokenCountError(code))
    }

    /** SIGKILLs the child and waits for it to be reaped before allowing a replacement. */
    private stopChild(): Promise<void> {
        clearTimeout(this.idleTimer)
        this.idleTimer = undefined
        clearTimeout(this.startupTimer)
        const child = this.child
        if (!child) return this.reaping ?? Promise.resolve()
        this.child = undefined
        this.ready = false
        this.stdout = ""
        const reaped = child.exitCode !== null || child.signalCode !== null
        const done = reaped
            ? Promise.resolve(true)
            : new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => resolve(false), this.limits.reapTimeoutMs)
                  child.once("exit", () => {
                      clearTimeout(timer)
                      resolve(true)
                  })
                  child.once("error", () => {})
                  child.kill("SIGKILL")
              })
        this.reaping = done.then((ok) => {
            process.off("exit", this.killOnExit)
            this.reaping = undefined
            if (!ok) {
                // Never overlap an unkillable child with a replacement.
                this.unavailable = true
                this.failAll("unavailable")
            }
        })
        return this.reaping
    }
}

/** Shared per-bundle counting service; its child starts on the first count. */
export const tokenCounter = new TokenCounter()
