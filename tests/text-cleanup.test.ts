import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "dcp-text-cleanup-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { createSessionState } = await import("../lib/state")
const { stripHallucinationsFromString } = await import("../lib/messages/utils")
const { createTextCompleteHandler } = await import("../lib/hooks")

// Verbatim from #562: the reply a model produced after being shown the
// <dcp-message-id> tag, with every fragment of that tag left unclosed.
const KIMI_REPLY = [
    "Which do you prefer?",
    "<<",
    "<<",
    "<<",
    "<<",
    "<<",
    "<<",
    "<<",
    "<",
    "<m0477",
    "<",
    "<",
    "<",
].join("\n")

test("broken tag debris at the end of a reply is removed", () => {
    assert.equal(stripHallucinationsFromString(KIMI_REPLY), "Which do you prefer?")
})

test("a single stray angle bracket is left alone", () => {
    const code = "if (a<b && c>d) {\n  return 1\n}"
    assert.equal(stripHallucinationsFromString(code), code)

    const prose = "Compare a < b"
    assert.equal(stripHallucinationsFromString(prose), prose)

    const oneLine = "The tag looks like <m0477"
    assert.equal(stripHallucinationsFromString(oneLine), oneLine)
})

test("debris that is not at the end of the reply is left alone", () => {
    // Cleanup is deliberately conservative: only a trailing run is removed, so
    // bracket-only lines in the middle of a reply are never rewritten.
    const text = ["intro", "<<", "<m0477", "still talking"].join("\n")
    assert.equal(stripHallucinationsFromString(text), text)
})

test("code blocks containing brackets are not touched", () => {
    const text = ["```ts", "<<", "<", "```", "done"].join("\n")
    assert.equal(stripHallucinationsFromString(text), text)
})

test("well formed injected tags are still stripped", () => {
    assert.equal(
        stripHallucinationsFromString("answer\n<dcp-message-id>m0477</dcp-message-id>"),
        "answer\n",
    )
    assert.equal(stripHallucinationsFromString("m0477</parameter>"), "m0477</parameter>")
})

test("text.complete strips echoed refs for compact sessions", async () => {
    const state = createSessionState("compact")
    const handler = createTextCompleteHandler(state)

    // Verbatim from #632: a model copying the compact reference tag into its
    // reply. The handler used the XML cleanup rules, which do not match @N@.
    const output = { text: "I will use @7@ [high] to compress.\n@b1@ done\n@blocked@" }
    await handler({ sessionID: "ses", messageID: "m", partID: "p" }, output)
    assert.equal(output.text, "I will use  to compress.\n done\n")
})

test("text.complete leaves ordinary compact text untouched", async () => {
    const state = createSessionState("compact")
    const handler = createTextCompleteHandler(state)
    const output = { text: "mail me at a@b.com, see <https://x.dev> for the patch" }
    await handler({ sessionID: "ses", messageID: "m", partID: "p" }, output)
    assert.equal(output.text, "mail me at a@b.com, see <https://x.dev> for the patch")
})
