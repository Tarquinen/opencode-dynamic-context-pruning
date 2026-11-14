#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { copyAuth } from "./sandbox/auth.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = resolve(process.env.DCP_SANDBOX_DIR || join(homedir(), ".local/state/dcp-sandbox"))
const separator = process.argv.indexOf("--", 2)
const cli = separator === -1 ? [] : process.argv.slice(separator + 1)
const { values } = parseArgs({
    args: process.argv.slice(2, separator === -1 ? undefined : separator),
    options: {
        help: { type: "boolean", short: "h" },
        fresh: { type: "boolean" },
        v1: { type: "boolean" },
        v2: { type: "boolean" },
        opencode: { type: "string" },
        dcp: { type: "string" },
        model: { type: "string" },
        transport: { type: "string" },
        logs: { type: "boolean" },
        path: { type: "boolean" },
    },
})

if (values.help) {
    console.log(`Usage: dcp-sandbox [options] [-- OpenCode arguments]

Open isolated OpenCode with DCP and the bundled test logger.
Sessions and scratch files persist. Local plugins are rebuilt on every launch.
Each launch uses the latest stable release of the selected major version.

  --v1                Use V1 over HTTP, with its own saved state
  --v2                Use V2 (default), with its own saved state
  --fresh             Start a new empty sandbox; keep old ones
  --logs              Show the latest raw/readable log paths and capture counts
  --path              Print the current sandbox's host directory
  --opencode VERSION  Use an exact version for this launch (V1 requires 1.18.29+)
  --dcp VERSION       Use npm DCP (e.g. latest or 3.2.1); default: local checkout
  --model MODEL       Remember a provider/model (otherwise OpenCode selects one)
  --transport TYPE    V2: websocket or http; V1: http only

Examples:
  dcp-sandbox
  dcp-sandbox --v1
  dcp-sandbox --dcp latest --fresh
  dcp-sandbox --opencode 2.0.12 --dcp 3.2.1
  dcp-sandbox --v1 --logs
  dcp-sandbox -- --continue
  dcp-sandbox -- run --format json "Reply with OK."

State: ${root}
Auth: saved credentials from the selected OpenCode version; override with DCP_AUTH_PATH
Override the state directory with DCP_SANDBOX_DIR.`)
    process.exit(0)
}

function json(path, fallback) {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback
}

function save(path, value) {
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
}

async function main() {
    process.umask(0o077)
    if (values.v1 && values.v2) throw new Error("Choose --v1 or --v2, not both.")
    const major = values.v1 ? 1 : values.v2 ? 2 : Number(values.opencode?.split(".")[0] || 2)
    if (![1, 2].includes(major)) throw new Error("Choose an OpenCode 1.x or 2.x version.")
    // Each major has independent sessions and settings.
    const state = major === 1 ? join(root, "v1") : root
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const current = join(state, "current.json")
    const profile = values.fresh ? stamp : json(current, "default")
    const home = join(state, "profiles", profile)
    if (values.path) {
        console.log(home)
        return
    }
    if (values.logs) {
        const latest = json(join(home, "latest.json"), null)
        if (!latest) throw new Error(`No launches recorded yet. Run dcp-sandbox --v${major} first.`)
        const logs = join(home, "logs", latest)
        console.log(`Readable logs: ${join(logs, "readable")}`)
        console.log(`Raw logs: ${join(logs, "raw")}`)
        const index = json(join(logs, "readable/index.json"), null)
        if (index) console.log(JSON.stringify(index.summary, null, 2))
        return
    }

    const interactive = process.stdin.isTTY && process.stdout.isTTY
    if (!interactive && cli.length === 0)
        throw new Error("An interactive terminal is required. For automation, use -- run <prompt>.")

    const settingsPath = join(state, "settings.json")
    const saved = json(settingsPath, {})
    const settings = {
        model: values.model ?? saved.model,
        transport: values.transport ?? saved.transport ?? (major === 1 ? "http" : undefined),
    }
    const dcp = values.dcp ?? "local"
    const packageName = major === 1 ? "opencode-ai" : "@opencode/cli"
    let release = values.opencode
    if (!release) {
        const versions = JSON.parse(
            execFileSync("npm", ["view", `${packageName}@${major}`, "version", "--json"], {
                encoding: "utf8",
            }),
        )
        release = Array.isArray(versions) ? versions.at(-1) : versions
    }
    const version = /^(1|2)\.(\d+)\.(\d+)(-[\w.-]+)?$/.exec(release)
    if (!version || Number(version[1]) !== major)
        throw new Error(
            `--opencode requires an exact ${major}.x version matching the selected host.`,
        )
    if (
        major === 1 &&
        (Number(version[2]) < 18 ||
            (Number(version[2]) === 18 &&
                (Number(version[3]) < 29 || (Number(version[3]) === 29 && version[4]))))
    )
        throw new Error("DCP's shared entrypoint requires OpenCode 1.18.29 or newer.")
    if (settings.model && !/^[^/]+\/.+$/.test(settings.model))
        throw new Error("--model must use provider/model format.")
    if (settings.transport && !["websocket", "http"].includes(settings.transport))
        throw new Error("--transport must be websocket or http.")
    if (major === 2 && settings.transport && !settings.model)
        throw new Error("Select --model provider/model when overriding its transport.")
    if (major === 1 && settings.transport !== "http")
        throw new Error(
            "The V1 sandbox uses HTTP so all requests can be logged. Use --transport http.",
        )

    const input = join(state, "launches", stamp)
    mkdirSync(input, { recursive: true, mode: 0o700 })
    mkdirSync(home, { recursive: true, mode: 0o700 })
    // Docker otherwise creates its bind-mounted WORKDIR as root.
    mkdirSync(join(home, "project"), { recursive: true, mode: 0o700 })
    const setup = join(input, "setup.log")
    function command(file, args, cwd = repo) {
        try {
            return execFileSync(file, args, {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (error) {
            writeFileSync(setup, `${error.stdout || ""}\n${error.stderr || ""}`, { mode: 0o600 })
            throw new Error(`${file} ${args.join(" ")} failed. Details: ${setup}`, { cause: error })
        }
    }
    command("docker", ["info", "--format", "{{.ServerVersion}}"])
    const image = `dcp-sandbox:${release}`
    console.log(`Preparing OpenCode ${release} container (cached after first build)…`)
    command("docker", [
        "build",
        "--build-arg",
        `VERSION=${release}`,
        "--build-arg",
        `PACKAGE=${packageName}`,
        "-t",
        image,
        join(repo, "scripts/sandbox"),
    ])
    console.log(dcp === "local" ? "Building DCP and request logger…" : "Building request logger…")
    if (!existsSync(join(repo, "node_modules"))) command("npm", ["ci", "--legacy-peer-deps"])
    const packages = []
    const directories = [join(repo, "tests/logger")]
    if (dcp === "local") directories.unshift(repo)
    for (const directory of directories) {
        command("npm", ["run", "build"], directory)
        const packed = JSON.parse(
            command(
                "npm",
                ["pack", "--ignore-scripts", "--json", "--pack-destination", input],
                directory,
            ),
        )
        packages.push(Object.values(packed)[0].filename)
    }
    const auth = join(input, "auth.json")
    try {
        copyAuth(major, auth, image)
        save(settingsPath, settings)
        save(current, profile)
        save(join(home, "latest.json"), stamp)
        save(join(input, "launch.json"), {
            ...settings,
            version: release,
            major,
            dcp:
                dcp === "local"
                    ? "/lab/plugins/node_modules/@mbarnett/opencode-dcp"
                    : `@mbarnett/opencode-dcp@${dcp}`,
            packages,
            stamp,
            args: cli,
        })
        console.log(
            `OpenCode ${release} · ${settings.model || "default model"} · ${settings.transport || "provider transport"}`,
        )
        console.log(`DCP: ${dcp === "local" ? "local checkout" : `@mbarnett/opencode-dcp@${dcp}`}`)
        console.log(`Workspace: ${join(home, "project")}`)
        console.log(`DCP config: ${join(home, "home/config/opencode/dcp.jsonc")}`)
        console.log(`Readable logs: ${join(home, "logs", stamp, "readable")}`)
        console.log(`Raw logs: ${join(home, "logs", stamp, "raw")}`)
        const child = spawn(
            "docker",
            [
                "run",
                "--rm",
                "--init",
                ...(interactive ? ["-it"] : ["-i"]),
                "--user",
                `${process.getuid()}:${process.getgid()}`,
                "--mount",
                `type=bind,source=${home},target=/lab`,
                "--mount",
                `type=bind,source=${input},target=/input,readonly`,
                "--mount",
                `type=bind,source=${join(repo, "scripts/sandbox")},target=/launcher,readonly`,
                "--env",
                `TERM=${process.env.TERM || "xterm-256color"}`,
                "--env",
                `COLORTERM=${process.env.COLORTERM || "truecolor"}`,
                image,
                "node",
                "/launcher/run.mjs",
            ],
            { stdio: "inherit" },
        )
        const stop = () => child.kill("SIGTERM")
        process.on("SIGTERM", stop)
        process.on("SIGINT", stop)
        try {
            process.exitCode = await new Promise((resolve, reject) => {
                child.once("error", reject)
                child.once("exit", (code) => resolve(code ?? 1))
            })
        } finally {
            process.off("SIGTERM", stop)
            process.off("SIGINT", stop)
        }
    } finally {
        rmSync(auth, { force: true })
    }
}

main().catch((error) => {
    console.error(`dcp-sandbox: ${error.message}`)
    process.exitCode = 1
})
