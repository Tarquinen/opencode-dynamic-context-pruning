// Exact token counting with the unchanged @anthropic-ai/tokenizer. Runs only inside the
// tokenizer child process (tokenizer-child.js), which kills its whole process
// on deadline because a worker executing WASM cannot be interrupted under Bun.
// No filesystem writes, network access or logging; text never leaves as output.
import { parentPort } from "node:worker_threads"
import * as tokenizer from "@anthropic-ai/tokenizer"

const countTokens = tokenizer.countTokens ?? tokenizer.default?.countTokens

parentPort.on("message", ({ id, text }) => {
    let count
    try {
        count = countTokens(text)
    } catch {
        parentPort.postMessage({ id, error: "encode" })
        return
    }
    parentPort.postMessage({ id, count })
})
parentPort.postMessage({ ready: true })
