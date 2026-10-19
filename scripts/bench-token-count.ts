// Bench for countTokens: legacy (the package's own countTokens, i.e. build+encode+free per call)
// versus the patched implementation. Measures wall time and missed 10 ms timer ticks (blocking).
//   npx tsx scripts/bench-token-count.ts [sizeKB...]
import { performance } from "node:perf_hooks"
import * as anthropicTokenizer from "@anthropic-ai/tokenizer"
import { countTokens, estimateTokensBatch } from "../lib/token-utils"

const legacyCountTokens = ((anthropicTokenizer as any).countTokens ??
    (anthropicTokenizer as any).default?.countTokens) as (text: string) => number

// Realistic mix of prose, code and JSON — what long sessions actually contain.
function synthSessionText(targetBytes: number): string {
    const chunk = [
        "user: refactor the billing cycle console so invoices are grouped per account",
        "assistant: I will start by reading the console controller and the invoice serializer.",
        '{"path":"apps/bud/app/controllers/billing/invoices_controller.rb","line":128,"text":"render json: InvoiceSerializer.new(invoice).as_json"}',
        "tool: bash -lc 'pnpm exec vitest run tests/serializers/invoice.test.ts' — 24 passed",
        "- [x] read controller\n- [ ] patch serializer\n- [ ] run tests",
        "assistant: The serializer now emits `cycle_started_at` and `cycle_ends_at`; tests pass.",
        "```ruby\ndef cycle_bounds(account)\n  [account.cycle_started_at, account.cycle_ends_at]\nend\n```",
    ].join("\n")
    const parts: string[] = []
    let bytes = 0
    while (bytes < targetBytes) {
        parts.push(chunk)
        bytes += chunk.length + 1
    }
    return parts.join("\n")
}

function measure(fn: () => number): { ms: number; tokens: number; missedTicks: number } {
    let ticks = 0
    const handle = setInterval(() => ticks++, 10)
    const start = performance.now()
    const tokens = fn()
    const ms = performance.now() - start
    clearInterval(handle)
    return { ms, tokens, missedTicks: Math.max(0, Math.floor(ms / 10) - ticks) }
}

const sizesKb = process.argv
    .slice(2)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
const kb = sizesKb.length > 0 ? sizesKb : [100, 1024, 8192]

console.log(`node ${process.version} | sizes(KB): ${kb.join(", ")}`)
console.log(
    "sizeKB\tchars\tlegacy ms\tlegacy ticks\tpatched ms\tpatched ticks\tpatched 2nd ms\ttokens",
)
for (const size of kb) {
    const text = synthSessionText(size * 1024)
    const legacy = measure(() => legacyCountTokens(text))
    const patched = measure(() => countTokens(text))
    const patched2 = measure(() => countTokens(text))
    console.log(
        [
            size,
            text.length,
            legacy.ms.toFixed(1),
            legacy.missedTicks,
            patched.ms.toFixed(1),
            patched.missedTicks,
            patched2.ms.toFixed(1),
            patched.tokens,
        ].join("\t"),
    )
}

// Batch path: master joined every text into one string before counting.
const batch = Array.from({ length: 200 }, (_, i) =>
    synthSessionText(2000).replace("user:", `tool ${i}:`),
)
const batchChars = batch.reduce((n, s) => n + s.length, 0)
const legacyBatch = measure(() => legacyCountTokens(batch.join(" ")))
const patchedBatch = measure(() => estimateTokensBatch(batch))
console.log(
    `\nestimateTokensBatch: 200 items (~${(batchChars / 1024).toFixed(0)} KB)\n` +
        `  legacy join+count: ${legacyBatch.ms.toFixed(1)} ms (${legacyBatch.missedTicks} ticks)\n` +
        `  per-item count:    ${patchedBatch.ms.toFixed(1)} ms (${patchedBatch.missedTicks} ticks) -> ${patchedBatch.tokens} tokens`,
)
