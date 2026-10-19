// Tokenizer child supervisor, launched by lib/token-counter.ts as a separate
// process. Its own event loop never loads the tokenizer: one contained worker
// (tokenizer-worker.js) does the uninterruptible WASM encoding, while this loop
// enforces hard deadlines by killing the whole process. It also dies on stdin
// closure, output failure, protocol errors, worker failure and idleness, so it
// cannot outlive its parent.
//
// Protocol (JSON lines): child -> {"ready":1,"protocol":P,"runtime":R}; parent ->
// {"id":N,"text":S,"deadlineMs":D}; child -> {"id":N,"count":C} or {"id":N,"error":CODE}.
// Only one job is in flight; raw text is never echoed, logged or put in errors.
import { Worker } from "node:worker_threads"

const PROTOCOL = "dcp-tokenizer/1"
const STARTUP_MS = 10_000
const IDLE_MS = 120_000
const MAX_DEADLINE_MS = 60_000
const MAX_TEXT_LENGTH = Number(process.argv[2])
// JSON escaping expands a UTF-16 code unit to at most six bytes.
const MAX_FRAME_BYTES = MAX_TEXT_LENGTH * 6 + 256

const hardStop = () => process.kill(process.pid, "SIGKILL")
if (!Number.isSafeInteger(MAX_TEXT_LENGTH) || MAX_TEXT_LENGTH <= 0) hardStop()

let timer = setTimeout(hardStop, STARTUP_MS)
let active = null
let ready = false
const chunks = []
let buffered = 0

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n")
process.stdout.on("error", hardStop)
process.stdin.on("end", hardStop)
process.stdin.on("close", hardStop)
process.stdin.on("error", hardStop)

const worker = new Worker(new URL("./tokenizer-worker.js", import.meta.url))
worker.on("error", hardStop)
worker.on("exit", hardStop)
worker.on("message", (message) => {
    if (!ready) {
        if (message?.ready !== true) hardStop()
        ready = true
        clearTimeout(timer)
        timer = setTimeout(hardStop, IDLE_MS)
        send({ ready: 1, protocol: PROTOCOL, runtime: process.versions.bun ? "bun" : "node" })
        drain()
        return
    }
    if (!active || message?.id !== active) hardStop()
    clearTimeout(timer)
    active = null
    if (message.error === "encode") send({ id: message.id, error: "encode" })
    else if (Number.isSafeInteger(message.count) && message.count >= 0)
        send({ id: message.id, count: message.count })
    else hardStop()
    timer = setTimeout(hardStop, IDLE_MS)
    drain()
})

process.stdin.on("data", (chunk) => {
    // One bounded frame at a time: input before readiness, during a job or beyond the frame
    // bound (plus its newline) is a protocol error and is never retained.
    if (!ready || active || buffered + chunk.length > MAX_FRAME_BYTES + 1) hardStop()
    chunks.push(chunk)
    buffered += chunk.length
    drain()
})

function drain() {
    if (buffered === 0) return
    const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    const newline = joined.indexOf(10)
    if (newline === -1) {
        chunks.length = 0
        chunks.push(joined)
        return
    }
    if (newline + 1 !== joined.length) hardStop()
    chunks.length = 0
    buffered = 0
    let frame
    try {
        frame = JSON.parse(joined.toString("utf8", 0, newline))
    } catch {
        hardStop()
    }
    const { id, text, deadlineMs } = frame ?? {}
    if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        typeof text !== "string" ||
        text.length > MAX_TEXT_LENGTH ||
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs <= 0 ||
        deadlineMs > MAX_DEADLINE_MS
    ) {
        hardStop()
    }
    clearTimeout(timer)
    active = id
    timer = setTimeout(hardStop, deadlineMs)
    worker.postMessage({ id, text })
}
