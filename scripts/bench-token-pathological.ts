// Warm-path bench for degenerate runs (upstream #659). Repeated chars in one process with a
// warmup call first, so the numbers separate real encode cost from JS/WASM startup.
//   timeout 120 npx tsx scripts/bench-token-pathological.ts [sizes...]
import { performance } from "node:perf_hooks"
import { countTokens } from "../lib/token-utils"

countTokens("warmup ".repeat(64))
countTokens("x".repeat(2048))

const sizes = process.argv.slice(2).map(Number)
const list = sizes.length > 0 ? sizes : [4096, 10000, 16384, 32768, 100000, 500000]

console.log("chars\tms\ttokens")
for (const size of list) {
    const text = "x".repeat(size)
    const start = performance.now()
    const tokens = countTokens(text)
    console.log(`${size}\t${(performance.now() - start).toFixed(1)}\t${tokens}`)
}
