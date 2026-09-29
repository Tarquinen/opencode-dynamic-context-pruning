import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import "./lab/persistence-env"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import assert from "node:assert/strict"
import { isAutoUpdatableSpec, isVersionNewer, updateRemoveDir } from "../lib/update"

test("isVersionNewer compares semver versions", () => {
    assert.equal(isVersionNewer("3.2.0", "3.1.9"), true)
    assert.equal(isVersionNewer("3.1.9", "3.1.9"), false)
    assert.equal(isVersionNewer("3.1.9", "3.2.0"), false)
    assert.equal(isVersionNewer("3.1.9", "3.1.9-beta.1"), true)
})

test("isAutoUpdatableSpec allows latest and ranges", () => {
    assert.equal(isAutoUpdatableSpec("latest"), true)
    assert.equal(isAutoUpdatableSpec("*"), true)
    assert.equal(isAutoUpdatableSpec("^3.1.9"), true)
    assert.equal(isAutoUpdatableSpec(">=3.1.9"), true)
})

test("isAutoUpdatableSpec rejects pinned and non-registry specs", () => {
    assert.equal(isAutoUpdatableSpec("3.1.9"), false)
    assert.equal(isAutoUpdatableSpec("file:../opencode-dcp"), false)
    assert.equal(isAutoUpdatableSpec("github:user/repo"), false)
})

test("updateRemoveDir removes opencode npm wrapper for latest installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@tarquinen", "opencode-dcp@latest")
    const packageDir = join(wrapperDir, "node_modules", "@tarquinen", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@tarquinen/opencode-dcp": "3.1.10" },
    })
    await writePackageJson(packageDir, {
        name: "@tarquinen/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await updateRemoveDir(packageDir, "@tarquinen/opencode-dcp"), wrapperDir)
})

test("updateRemoveDir skips version-locked opencode installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@tarquinen", "opencode-dcp@3.1.9")
    const packageDir = join(wrapperDir, "node_modules", "@tarquinen", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@tarquinen/opencode-dcp": "3.1.9" },
    })
    await writePackageJson(packageDir, {
        name: "@tarquinen/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await updateRemoveDir(packageDir, "@tarquinen/opencode-dcp"), undefined)
})

async function writePackageJson(dir: string, data: Record<string, unknown>) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), `${JSON.stringify(data)}\n`, "utf-8")
}
