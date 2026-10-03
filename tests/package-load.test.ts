import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

// opencode installs plugins into its own cache directory, where the packages
// listed in `dependencies` are present but peers and devDependencies are not.
// @opencode-ai/plugin is a peer, and because `tool()` is a value import the
// import statement used to survive into dist/index.js, throw on load, and get
// the plugin dropped by opencode's dynamic-import try/catch without surfacing
// anything (#585).

const root = resolve(import.meta.dirname, "..")
const distEntry = join(root, "dist", "index.js")
const repoModules = join(root, "node_modules")
const built = existsSync(distEntry)

// opencode's cache layout: runtime dependencies present, peers absent.
const CACHE_EXCLUDED = new Set(["@opencode-ai/plugin"])

function linkInstalledPackages(target: string): void {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(repoModules, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue
        const source = join(repoModules, entry.name)
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

        if (entry.name.startsWith("@")) {
            mkdirSync(join(target, entry.name), { recursive: true })
            for (const scoped of readdirSync(source)) {
                if (CACHE_EXCLUDED.has(`${entry.name}/${scoped}`)) continue
                symlinkSync(join(source, scoped), join(target, entry.name, scoped), "junction")
            }
            continue
        }

        symlinkSync(source, join(target, entry.name), "junction")
    }
}

function buildCacheSandbox(): string {
    const sandbox = mkdtempSync(join(tmpdir(), "dcp-plugin-cache-"))
    mkdirSync(join(sandbox, "dist"), { recursive: true })
    copyFileSync(distEntry, join(sandbox, "dist", "index.js"))
    copyFileSync(join(root, "package.json"), join(sandbox, "package.json"))
    linkInstalledPackages(join(sandbox, "node_modules"))
    return sandbox
}

test("the built plugin entry has no bare @opencode-ai/plugin import", { skip: !built }, () => {
    const source = readFileSync(distEntry, "utf8")
    const runtimeImports = [
        ...source.matchAll(
            /(?:^|[;\s])(?:import|export)[^;'"]*from\s*["']@opencode-ai\/plugin["']/g,
        ),
    ]

    assert.deepEqual(
        runtimeImports.map((m) => m[0]),
        [],
        "dist/index.js still imports @opencode-ai/plugin at runtime",
    )
})

test("the built entry loads from an opencode-style plugin cache", { skip: !built }, () => {
    const sandbox = buildCacheSandbox()
    try {
        // Precondition: the sandbox really does model opencode's cache.
        assert.equal(
            existsSync(join(sandbox, "node_modules", "@opencode-ai", "plugin")),
            false,
            "sandbox must not provide the peer dependency",
        )
        assert.equal(
            existsSync(join(sandbox, "node_modules", "@opencode-ai", "sdk")),
            true,
            "sandbox must provide the runtime dependency",
        )
        assert.equal(existsSync(join(sandbox, "node_modules", "@anthropic-ai", "tokenizer")), true)

        const entryUrl = pathToFileURL(join(sandbox, "dist", "index.js")).href
        const script = `import(${JSON.stringify(entryUrl)})
                .then((m) => { console.log(m.default?.id === "opencode-dcp" ? "OK" : "NO_DEFAULT") })
                .catch((e) => { console.log("ERR: " + e.message); process.exit(1) })`
        const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
            encoding: "utf8",
            cwd: sandbox,
        })

        assert.match(output, /OK/)
    } finally {
        rmSync(sandbox, { recursive: true, force: true })
    }
})

test(
    "the built entry keeps working when the peer dependency is available",
    { skip: !built },
    async () => {
        // Guards against bundling changing behaviour: with @opencode-ai/plugin
        // resolvable, the plugin must still register its hooks.
        const sandbox = mkdtempSync(join(tmpdir(), "dcp-plugin-full-"))
        try {
            mkdirSync(join(sandbox, "dist"), { recursive: true })
            copyFileSync(distEntry, join(sandbox, "dist", "index.js"))
            writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }))
            symlinkSync(repoModules, join(sandbox, "node_modules"), "junction")

            const module = await import(pathToFileURL(join(sandbox, "dist", "index.js")).href)
            assert.equal(module.default.id, "opencode-dcp")
            assert.equal(typeof module.default.setup, "function")
            assert.equal(typeof module.default.server, "function")
        } finally {
            rmSync(sandbox, { recursive: true, force: true })
        }
    },
)

test("tsup keeps the plugin package in the bundle", () => {
    const config = readFileSync(join(root, "tsup.config.ts"), "utf8")
    assert.match(
        config,
        /noExternal[\s\S]*"@opencode-ai\/plugin"/,
        "tsup must bundle @opencode-ai/plugin or the load failure returns",
    )
})

test("@opencode-ai/plugin is still declared as a peer, not a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    assert.ok(
        pkg.peerDependencies?.["@opencode-ai/plugin"],
        "the peer range is what opencode resolves against",
    )
    assert.equal(
        pkg.dependencies?.["@opencode-ai/plugin"],
        undefined,
        "bundling it makes a runtime dependency unnecessary",
    )
})
