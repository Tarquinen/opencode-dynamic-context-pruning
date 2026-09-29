import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import type { WithParts } from "../lib/state"
import {
    COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
    countAllMessageTokens,
    countToolTokens,
    estimateTokensBatch,
    extractCompletedToolOutput,
    extractToolContent,
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
