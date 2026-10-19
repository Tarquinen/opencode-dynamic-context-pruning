import { builtinModules, createRequire } from "node:module"
import { existsSync, readFileSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const builtinNames = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => name.replace(/^node:/, "")),
])

const requiredRepoFiles = [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/tui.d.ts",
    "tui.tsx",
    "server.js",
    "lib/tokenizer/tokenizer-child.js",
    "lib/tokenizer/tokenizer-worker.js",
    "lib/tokenizer/tokenizer-runtime.bunfig.toml",
    "lib/tokenizer/tsconfig.json",
    "README.md",
    "LICENSE",
]

const requiredTarballFiles = [
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/tui.d.ts",
    "tui.tsx",
    "server.js",
    "lib/tokenizer/tokenizer-child.js",
    "lib/tokenizer/tokenizer-worker.js",
    "lib/tokenizer/tokenizer-runtime.bunfig.toml",
    "lib/tokenizer/tsconfig.json",
    "README.md",
    "LICENSE",
]

const forbiddenTarballPatterns = [
    /^node_modules\//,
    /^index\.ts$/,
    /^tests\//,
    /^scripts\//,
    /^docs\//,
    /^assets\//,
    /^notes\//,
    /^\.github\//,
    /^package-lock\.json$/,
    /^tsconfig\.json$/,
]

const packageInfoCache = new Map()

function fail(message) {
    console.error(`package verification failed: ${message}`)
    process.exit(1)
}

function assertRepoFilesExist() {
    for (const relativePath of requiredRepoFiles) {
        if (!existsSync(path.join(root, relativePath))) {
            fail(`missing required file: ${relativePath}`)
        }
    }
}

function assertPackageJsonShape() {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

    if (pkg.main !== "./dist/index.js") {
        fail(`package.json main must remain ./dist/index.js, found ${pkg.main ?? "<missing>"}`)
    }

    if (pkg.exports?.["."]?.import !== "./dist/index.js") {
        fail("expected package.json exports['.'].import to be './dist/index.js'")
    }

    if (pkg.exports?.["./server"]?.import !== "./dist/index.js") {
        fail("expected package.json exports['./server'].import to be './dist/index.js'")
    }

    if (pkg.exports?.["./tui"]?.import !== "./tui.tsx") {
        fail("expected package.json exports['./tui'].import to be './tui.tsx'")
    }

    const files = Array.isArray(pkg.files) ? pkg.files : []
    for (const entry of ["dist/", "lib/", "tui.tsx", "README.md", "LICENSE"]) {
        if (!files.includes(entry)) {
            fail(`package.json files must include ${entry}`)
        }
    }
}

function getImportStatements(source) {
    const pattern = /^\s*import\s+([^\n;]+?)\s+from\s+["']([^"']+)["']/gm
    return Array.from(source.matchAll(pattern), (match) => ({
        clause: match[1].trim(),
        specifier: match[2],
    }))
}

function getImportKind(clause) {
    if (clause.startsWith("type ")) return "type"
    if (clause.startsWith("* as ")) return "namespace"
    if (clause.startsWith("{")) return "named"
    if (clause.includes(",")) {
        const [, trailing = ""] = clause.split(",", 2)
        return trailing.trim().startsWith("* as ") ? "default+namespace" : "default+named"
    }
    return "default"
}

function getPackageName(specifier) {
    if (specifier.startsWith("@")) {
        const parts = specifier.split("/")
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
    }
    return specifier.split("/")[0]
}

function resolveLocalImport(importerPath, specifier) {
    const basePath = path.resolve(path.dirname(importerPath), specifier)
    const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.mjs`,
        path.join(basePath, "index.ts"),
        path.join(basePath, "index.tsx"),
        path.join(basePath, "index.js"),
        path.join(basePath, "index.mjs"),
    ]

    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }

    fail(`unable to resolve local import ${specifier} from ${path.relative(root, importerPath)}`)
}

function findPackageInfo(packageName, importerPath) {
    const cacheKey = `${packageName}::${path.dirname(importerPath)}`
    if (packageInfoCache.has(cacheKey)) {
        return packageInfoCache.get(cacheKey)
    }

    let entry
    try {
        entry = require.resolve(packageName, { paths: [path.dirname(importerPath)] })
    } catch {
        packageInfoCache.set(cacheKey, null)
        return null
    }

    let current = path.dirname(entry)
    while (true) {
        const manifest = path.join(current, "package.json")
        if (existsSync(manifest)) {
            const info = JSON.parse(readFileSync(manifest, "utf8"))
            packageInfoCache.set(cacheKey, info)
            return info
        }
        const parent = path.dirname(current)
        if (parent === current) {
            packageInfoCache.set(cacheKey, null)
            return null
        }
        current = parent
    }
}

function packageLooksCommonJs(pkg) {
    if (!pkg) return false
    if (pkg.type === "commonjs") return true

    const main = typeof pkg.main === "string" ? pkg.main : ""
    return /(?:^|\/)(cjs|umd)(?:\/|$)/.test(main) || main.endsWith(".cjs")
}

function validateRuntimeImportGraph() {
    // The tokenizer sidecars are spawned, not imported, so list them explicitly.
    const pending = [
        path.join(root, "index.ts"),
        path.join(root, "tui.tsx"),
        path.join(root, "lib/tokenizer/tokenizer-child.js"),
        path.join(root, "lib/tokenizer/tokenizer-worker.js"),
    ]
    const seen = new Set()

    while (pending.length > 0) {
        const filePath = pending.pop()
        if (!filePath || seen.has(filePath)) continue
        seen.add(filePath)

        const source = readFileSync(filePath, "utf8")
        for (const entry of getImportStatements(source)) {
            if (entry.specifier.startsWith(".")) {
                pending.push(resolveLocalImport(filePath, entry.specifier))
                continue
            }

            if (entry.specifier === "jsonc-parser/lib/esm/main.js") {
                continue
            }

            const packageName = getPackageName(entry.specifier)
            if (builtinNames.has(packageName)) continue

            const kind = getImportKind(entry.clause)
            if (kind === "type" || kind === "namespace") continue

            const pkg = findPackageInfo(packageName, filePath)
            if (packageLooksCommonJs(pkg)) {
                fail(
                    `${path.relative(root, filePath)} uses ${kind} import from CommonJS-style package ${packageName}`,
                )
            }
        }
    }
}

function validatePackedFiles() {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
    })

    // npm versions return either an array or an object keyed by package name.
    const [result] = Object.values(JSON.parse(output))
    if (!result || !Array.isArray(result.files)) {
        fail("npm pack --dry-run --json did not return file metadata")
    }

    const packedPaths = result.files.map((file) => file.path)
    for (const required of requiredTarballFiles) {
        if (!packedPaths.includes(required)) {
            fail(`packed tarball is missing ${required}`)
        }
    }

    const forbidden = packedPaths.find((file) =>
        forbiddenTarballPatterns.some((pattern) => pattern.test(file)),
    )
    if (forbidden) {
        fail(`packed tarball contains forbidden path ${forbidden}`)
    }

    console.log(`package verification passed for ${result.name}@${result.version}`)
    console.log(`tarball entries: ${result.entryCount}`)
}

assertRepoFilesExist()
assertPackageJsonShape()
validateRuntimeImportGraph()
validatePackedFiles()
