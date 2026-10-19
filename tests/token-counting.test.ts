import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import {
    COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
    countAllMessageTokens,
    countTokens,
    countToolTokens,
    estimateTokensBatch,
    extractCompletedToolOutput,
    extractToolContent,
    resetTokenCountingForTests,
} from "../lib/token-utils"

function buildToolMessage(part: Record<string, any>): WithParts {
    return {
        info: {
            id: "msg-tool",
            role: "assistant",
            sessionID: "ses_token_counting",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [part as any],
    }
}

function buildToolPart(tool: string, state: Record<string, any>) {
    return {
        id: `tool-${tool}`,
        messageID: "msg-tool",
        sessionID: "ses_token_counting",
        type: "tool" as const,
        tool,
        callID: `call-${tool}`,
        state,
    }
}

function assertCounted(part: Record<string, any>, expectedContents: string[]) {
    assert.deepEqual(extractToolContent(part), expectedContents)
    assert.equal(countToolTokens(part), estimateTokensBatch(expectedContents))
    assert.equal(
        countAllMessageTokens(buildToolMessage(part)),
        estimateTokensBatch(expectedContents),
    )
}

test("counting includes input for large built-in tool calls", () => {
    const cases = [
        {
            tool: "compress",
            input: {
                topic: "Compression topic",
                content: [
                    { messageId: "m0001", topic: "Prior work", summary: "Compressed summary" },
                ],
            },
            output: "compressed",
        },
        {
            tool: "apply_patch",
            input: {
                patchText: [
                    "*** Begin Patch",
                    "*** Update File: src/example.ts",
                    "@@",
                    "-oldLine()",
                    "+newLine()",
                    "*** End Patch",
                ].join("\n"),
            },
            output: "Success. Updated the following files:\nM src/example.ts",
        },
        {
            tool: "task",
            input: {
                description: "Research bug",
                prompt: "Investigate the failing workflow and summarize root cause.",
                subagent_type: "general",
                command: "/investigate",
            },
            output: "Queued task ses_123",
        },
        {
            tool: "bash",
            input: {
                command: "python - <<'PY'\nprint(\"hello\")\nPY",
                description: "Runs inline Python script",
                workdir: "/tmp/project",
            },
            output: "hello",
        },
        {
            tool: "batch",
            input: {
                calls: [
                    { tool: "read", parameters: { filePath: "/tmp/a.txt" } },
                    { tool: "grep", parameters: { pattern: "TODO", path: "/tmp" } },
                ],
            },
            output: [
                { tool: "read", ok: true },
                { tool: "grep", ok: true },
            ],
        },
        {
            tool: "todowrite",
            input: {
                todos: [
                    { content: "Inspect bug", status: "in_progress", priority: "high" },
                    { content: "Write fix", status: "pending", priority: "high" },
                ],
            },
            output: [{ content: "Inspect bug", status: "completed", priority: "high" }],
        },
        {
            tool: "question",
            input: {
                questions: [
                    {
                        question: "Use the safer option?",
                        header: "Confirm",
                        options: [{ label: "Yes", description: "Proceed safely" }],
                    },
                ],
            },
            output: ["Yes"],
        },
    ]

    for (const testCase of cases) {
        const part = buildToolPart(testCase.tool, {
            status: "completed",
            input: testCase.input,
            output: testCase.output,
        })
        const expectedContents = [
            JSON.stringify(testCase.input),
            typeof testCase.output === "string" ? testCase.output : JSON.stringify(testCase.output),
        ]

        assertCounted(part, expectedContents)
    }
})

test("counting includes input for errored custom tools", () => {
    const customInput = {
        payload: "some large custom tool payload",
        options: { mode: "deep" },
    }
    const part = buildToolPart("custom_tool", {
        status: "error",
        input: customInput,
        error: "Tool execution failed",
    })

    assertCounted(part, [JSON.stringify(customInput), "Tool execution failed"])
})

test("counting uses the compacted tool placeholder for completed outputs", () => {
    const input = { filePath: "/tmp/large.log" }
    const part = buildToolPart("read", {
        status: "completed",
        input,
        output: "full original output that is no longer visible to the model",
        time: {
            start: 1,
            end: 2,
            compacted: 3,
        },
    })

    assert.equal(extractCompletedToolOutput(part), COMPACTED_TOOL_OUTPUT_PLACEHOLDER)
    assertCounted(part, [JSON.stringify(input), COMPACTED_TOOL_OUTPUT_PLACEHOLDER])
})

// --- shared tokenizer, bounded counting and caching (upstream #638/#659) ---

async function referenceTokenizer() {
    const tokenizer = await import("@anthropic-ai/tokenizer")
    return ((tokenizer as any).countTokens ?? (tokenizer as any).default?.countTokens) as (
        text: string,
    ) => number
}

function measure(fn: () => number): { ms: number; tokens: number } {
    const start = performance.now()
    const tokens = fn()
    return { ms: performance.now() - start, tokens }
}

function repeatTo(chars: number, unit: string): string {
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

test("countTokens matches the reference tokenizer and reuses one tokenizer", async () => {
    const reference = await referenceTokenizer()
    const samples = [
        "hello world",
        "Crème brûlée — ﬁ ligature ① and emoji 🚀",
        JSON.stringify({ path: "src/index.ts", edits: [{ line: 1, text: "const x = 1" }] }),
        "x".repeat(1000),
        "<|endoftext|> special tokens are counted, not rejected",
    ]
    for (const sample of samples) assert.equal(countTokens(sample), reference(sample))

    // Building a tokenizer per call took ~70 ms; 200 calls with a shared one take a few ms.
    resetTokenCountingForTests()
    const unit = "tool output with words, punctuation and identifiers. "
    const start = performance.now()
    for (let index = 0; index < 200; index++) {
        assert.ok(countTokens(`${index} ${unit}`) > 0)
    }
    const elapsed = performance.now() - start
    assert.ok(elapsed < 6_000, `200 counts took ${elapsed.toFixed(0)} ms; is the tokenizer shared?`)
})

test("countTokens bounds the cost of huge and degenerate inputs", () => {
    const realistic = repeatTo(4 * 1024 * 1024, "counts must stay bounded on huge inputs. ")
    const realisticRun = measure(() => countTokens(realistic))
    assert.ok(
        realisticRun.ms < 1_000,
        `counting 4 MB took ${realisticRun.ms.toFixed(0)} ms; exact counting is unbounded`,
    )

    const degenerate = "x".repeat(2 * 1024 * 1024)
    const degenerateRun = measure(() => countTokens(degenerate))
    assert.ok(
        degenerateRun.ms < 1_000,
        `counting a 2 MB single-character run took ${degenerateRun.ms.toFixed(0)} ms`,
    )
})

test("countTokens caches exact counts", () => {
    resetTokenCountingForTests()
    const text = repeatTo(7000, "cached content with words, punctuation and identifiers. ")
    const first = measure(() => countTokens(text))
    assert.ok(first.tokens > 0)

    const start = performance.now()
    for (let index = 0; index < 500; index++) assert.equal(countTokens(text), first.tokens)
    const elapsed = performance.now() - start
    assert.ok(elapsed < 1_000, `500 cached counts took ${elapsed.toFixed(0)} ms`)
})

test("sampled estimates stay close to exact counts above the limit", async () => {
    const reference = await referenceTokenizer()
    process.env.DCP_TOKEN_COUNT_MAX_EXACT_CHARS = "0"
    try {
        const units = [
            "memory context pruning keeps summaries technical and dense. ",
            '{"tool":"read","input":{"filePath":"/tmp/app.log","limit":2000}} ',
            "def compress(block)\n  summary_tokens = count(block.summary)\nend\n",
        ]
        for (const unit of units) {
            const text = repeatTo(64 * 1024, unit)
            const exact = reference(text)
            const estimated = countTokens(text)
            const error = Math.abs(estimated - exact) / exact
            assert.ok(
                error < 0.1,
                `sampled estimate off by ${(error * 100).toFixed(1)}% for "${unit.slice(0, 24)}"`,
            )
        }
    } finally {
        delete process.env.DCP_TOKEN_COUNT_MAX_EXACT_CHARS
    }
})
