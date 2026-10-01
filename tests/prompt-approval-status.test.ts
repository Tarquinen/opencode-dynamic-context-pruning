import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "dcp-prompt-approval-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { rangePrompt } = await import("../lib/prompts/compress-range")
const { messagePrompt } = await import("../lib/prompts/compress-message")

const PROMPTS = [
    ["range", rangePrompt("xml")],
    ["range compact", rangePrompt("compact")],
    ["message", messagePrompt("xml")],
    ["message compact", messagePrompt("compact")],
] as const

// A compressed range is history. If the summary ends with a user approval as a
// bare imperative, a later turn - notably a PLAN-mode agent - can read it as the
// current instruction and start modifying files (#560).
test("every compress prompt states that a summary is history", () => {
    for (const [name, prompt] of PROMPTS) {
        assert.match(prompt, /TEMPORAL STATUS OF USER MESSAGES/, name)
        assert.match(prompt, /HISTORY, not the current instruction/, name)
    }
})

test("every compress prompt forbids replaying an approval as a live instruction", () => {
    for (const [name, prompt] of PROMPTS) {
        assert.match(prompt, /approvals?/i, name)
        assert.match(prompt, /recorded as a past event[^.]*never as a live instruction/i, name)
        assert.match(prompt, /PLAN-mode agent/i, name)
    }
})

test("the range prompt forbids ending a summary on an approval", () => {
    for (const [name, prompt] of [PROMPTS[0], PROMPTS[1]]) {
        assert.match(prompt, /Never end a summary with an imperative sentence/i, name)
        assert.match(prompt, /Never place an approval at the end of the summary/i, name)
    }
})

test("the range prompt requires the later instruction to win", () => {
    for (const [name, prompt] of [PROMPTS[0], PROMPTS[1]]) {
        assert.match(prompt, /narrows, overrides or cancels it/i, name)
        assert.match(prompt, /make the later one the operative one/i, name)
    }
})

test("an unresolved decision must stay unresolved", () => {
    for (const [name, prompt] of [PROMPTS[0], PROMPTS[1]]) {
        assert.match(prompt, /unresolved/i, name)
    }
})

test("the existing prompt contracts are untouched", () => {
    // Range mode keeps the block placeholder contract that the tool schema and
    // the id format depend on.
    for (const prompt of [rangePrompt("xml"), rangePrompt("compact")]) {
        assert.match(prompt, /Include every required block placeholder exactly once/)
        assert.match(prompt, /startId/)
    }
    // Message mode keeps the id contract.
    for (const prompt of [messagePrompt("xml"), messagePrompt("compact")]) {
        assert.match(prompt, /messageId/)
    }
    assert.match(rangePrompt("compact"), /@b1@/)
    assert.match(rangePrompt("xml"), /<dcp-message-id/)
    assert.match(messagePrompt("compact"), /@7@ \[high\]/)
    assert.match(messagePrompt("xml"), /m0007/)
})
