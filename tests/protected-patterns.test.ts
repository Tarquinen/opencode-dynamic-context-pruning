import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
    matchesGlob,
} from "../lib/protected-patterns"

// A single backslash, built from its char code so the intent survives any later
// reformatting of this file. The bug being pinned here was precisely an escaping
// mistake in a string literal, so the tests avoid writing one by hand.
const BS = String.fromCharCode(92)
const winPath = (...segments: string[]) => segments.join(BS)

test("matchesGlob treats a Windows separator as a path separator", () => {
    // `protectedFilePatterns` is documented with forward slashes ("**/*.config.ts"),
    // but on Windows the tool parameters carry backslashes. Both sides are
    // normalised, so the same pattern must match either spelling of the same file.
    const path = winPath("C:", "repo", "src", "config", "secrets.ts")

    assert.equal(matchesGlob(path, "**/secrets.ts"), true)
    assert.equal(matchesGlob(path, "**/config/*.ts"), true)
    assert.equal(matchesGlob(path, "C:/repo/src/**"), true)
    assert.equal(matchesGlob(path, "**/*.ts"), true)
})

test("matchesGlob accepts a pattern written with Windows separators", () => {
    // Normalisation applies to the pattern too, so a user who copies a path out of
    // Explorer and uses it as a pattern gets the same result as the documented form.
    const pattern = winPath("**", "config", "*.ts")

    assert.equal(matchesGlob("C:/repo/src/config/secrets.ts", pattern), true)
    assert.equal(matchesGlob(winPath("C:", "repo", "src", "config", "secrets.ts"), pattern), true)
})

test("a single-segment wildcard still does not cross a Windows separator", () => {
    // `*` is defined as "[^/]*". Normalisation must convert separators rather than
    // erase them, or `*` would silently start matching across directories.
    assert.equal(matchesGlob(winPath("src", "config", "secrets.ts"), "src/*"), false)
    assert.equal(matchesGlob(winPath("src", "config", "secrets.ts"), "src/*/*.ts"), true)
    assert.equal(matchesGlob(winPath("src", "secrets.ts"), "src/*"), true)
})

test("isFilePathProtected protects a Windows path the user configured", () => {
    // The end-to-end shape: a `read` tool call on Windows, checked against the
    // documented pattern style. This is the assertion that failed before the fix --
    // the file was protected on POSIX and unprotected on Windows.
    const patterns = ["**/secrets.ts", "**/.env"]

    for (const path of [
        "C:/repo/src/config/secrets.ts",
        winPath("C:", "repo", "src", "config", "secrets.ts"),
    ]) {
        const paths = getFilePathsFromParameters("read", { filePath: path })
        assert.equal(isFilePathProtected(paths, patterns), true, `not protected: ${path}`)
    }
})

test("isFilePathProtected still returns false for a genuinely unmatched path", () => {
    // The fix must widen matching only for separators, not for anything else.
    const paths = getFilePathsFromParameters("read", {
        filePath: winPath("C:", "repo", "src", "main.ts"),
    })

    assert.equal(isFilePathProtected(paths, ["**/secrets.ts"]), false)
    assert.equal(isFilePathProtected(paths, []), false)
    assert.equal(isFilePathProtected([], ["**/*.ts"]), false)
})

test("multiedit and apply_patch paths are protected on Windows too", () => {
    // These two tools carry paths in shapes of their own, so they need their own
    // coverage: a nested `edits` array and paths embedded in patch text.
    const patterns = ["**/secrets.ts"]

    const multiedit = getFilePathsFromParameters("multiedit", {
        filePath: winPath("src", "main.ts"),
        edits: [{ filePath: winPath("src", "config", "secrets.ts") }],
    })
    assert.equal(isFilePathProtected(multiedit, patterns), true)

    const patch = getFilePathsFromParameters("apply_patch", {
        patchText: `*** Update File: ${winPath("src", "config", "secrets.ts")}\n@@\n-a\n+b\n`,
    })
    assert.equal(isFilePathProtected(patch, patterns), true)
})

test("isToolNameProtected is unaffected by separator normalisation", () => {
    // Tool names contain no separators; this pins that the shared helper does not
    // change their behaviour.
    assert.equal(isToolNameProtected("bash", ["bash"]), true)
    assert.equal(isToolNameProtected("bash", ["ba*"]), true)
    assert.equal(isToolNameProtected("bash", ["read"]), false)
    assert.equal(isToolNameProtected("bash", []), false)
    assert.equal(isToolNameProtected("", ["bash"]), false)
})

test("matchesGlob rejects an empty pattern and handles regex metacharacters", () => {
    // Pattern text is interpolated into a RegExp, so characters that mean something
    // there must be matched literally.
    assert.equal(matchesGlob("a/b.ts", ""), false)
    assert.equal(matchesGlob("src/a+b(1).ts", "src/a+b(1).ts"), true)
    assert.equal(matchesGlob("src/axb1.ts", "src/a+b(1).ts"), false)
})
