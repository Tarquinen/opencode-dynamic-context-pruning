// Accuracy of the sampled estimator against exact BPE counting, for texts above the
// exact-count limit. Run: npx tsx scripts/bench-token-accuracy.ts
import * as t from "@anthropic-ai/tokenizer"
import { countTokens } from "../lib/token-utils"

const getTokenizer = ((t as any).getTokenizer ??
    (t as any).default?.getTokenizer) as typeof t.getTokenizer
const tokenizer = getTokenizer()
const exactCount = (text: string): number => tokenizer.encode(text.normalize("NFKC"), "all").length

const prose =
    "The billing cycle console groups invoices per account and shows the cycle window for each subscription. "
const json =
    '{"path":"apps/bud/app/models/invoice.rb","line":42,"text":"scope :open, -> { where(paid_at: nil) },"} '
const code =
    "def cycle_bounds(account)\n  [account.cycle_started_at, account.cycle_ends_at]\nend\n\n"

function build(kind: string, targetChars: number): string {
    const unit =
        kind === "prose"
            ? prose
            : kind === "json"
              ? json
              : kind === "code"
                ? code
                : prose + json + code
    const parts: string[] = []
    let chars = 0
    while (chars < targetChars) {
        parts.push(unit)
        chars += unit.length
    }
    return parts.join("")
}

function mixedHalves(targetChars: number): string {
    const half = build("prose", targetChars / 2)
    const b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(Math.ceil(targetChars / 2 / 36))
    return half + b64
}

const sizes = [32 * 1024, 128 * 1024, 512 * 1024, 1024 * 1024, 8 * 1024 * 1024]
console.log("kind\tsizeKB\texact\tsampled\terror%")
for (const [kind, text] of [
    ...sizes.map((s) => ["prose", build("prose", s)] as const),
    ...sizes.map((s) => ["json", build("json", s)] as const),
    ...sizes.map((s) => ["code", build("code", s)] as const),
    ...sizes.map((s) => ["mixed-halves", mixedHalves(s)] as const),
]) {
    const exact = exactCount(text)
    const sampled = countTokens(text)
    const error = ((sampled - exact) / exact) * 100
    console.log(
        `${kind}\t${(text.length / 1024).toFixed(0)}\t${exact}\t${sampled}\t${error.toFixed(2)}%`,
    )
}
