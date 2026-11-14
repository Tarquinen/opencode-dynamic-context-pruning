import { execFileSync, spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { restoreAuth } from "./auth.mjs"

process.umask(0o077)
const launch = JSON.parse(await readFile("/input/launch.json", "utf8"))
// Only install this launch's tarballs, even after switching away from local DCP.
await mkdir("/lab/plugins", { recursive: true })
await writeFile("/lab/plugins/package.json", JSON.stringify({ private: true }) + "\n")
try {
    execFileSync(
        "npm",
        [
            "install",
            "--prefix",
            "/lab/plugins",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            ...launch.packages.map((file) => join("/input", file)),
        ],
        { stdio: "pipe" },
    )
} catch (error) {
    console.error(error.stderr?.toString() || error.message)
    process.exit(1)
}
const logger = "/lab/plugins/node_modules/opencode-request-logger"
const dcp = launch.dcp
const { createRelay } = await import(pathToFileURL(join(logger, "relay.mjs")))
const { watch } = await import(pathToFileURL(join(logger, "readable.mjs")))
const logs = join("/lab/logs", launch.stamp)
const raw = join(logs, "raw")
const config = process.env.OPENCODE_CONFIG_DIR
const cli = `/opt/opencode/node_modules/.bin/${launch.major === 1 ? "opencode" : "opencode2"}`
const separator = launch.model?.indexOf("/")
const providers =
    launch.model && launch.transport
        ? {
              [launch.model.slice(0, separator)]: {
                  models: {
                      [launch.model.slice(separator + 1)]: { transport: launch.transport },
                  },
              },
          }
        : undefined
await Promise.all([raw, config, "/lab/project"].map((path) => mkdir(path, { recursive: true })))
const readable = await watch(raw, join(logs, "readable"))
const relay = createRelay({ directory: raw })
await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve))
try {
    await writeFile(
        join(config, "opencode.json"),
        JSON.stringify(
            launch.major === 1
                ? {
                      $schema: "https://opencode.ai/config.json",
                      autoupdate: false,
                      model: launch.model,
                      small_model: launch.model,
                      plugin: [dcp, logger],
                      permission: { compress: "allow" },
                  }
                : {
                      $schema: "https://opencode.ai/config.json",
                      update: "disable",
                      model: launch.model,
                      plugins: [
                          { package: dcp },
                          {
                              package: logger,
                              options: {
                                  directory: raw,
                                  relay: `ws://127.0.0.1:${relay.server.address().port}`,
                              },
                          },
                      ],
                      permissions: [{ action: "compress", resource: "*", effect: "allow" }],
                      providers,
                  },
            null,
            2,
        ) + "\n",
    )
    if (launch.major === 1) {
        // Keep the panel's source in sync, retaining user terminal preferences.
        const path = join(config, "tui.json")
        let tui = {}
        try {
            tui = JSON.parse(await readFile(path, "utf8"))
        } catch (error) {
            if (error.code !== "ENOENT") throw error
        }
        const plugins = [dcp]
        for (const plugin of tui.plugin ?? []) {
            if (
                typeof plugin === "string" &&
                (plugin === "/lab/plugins/node_modules/@mbarnett/opencode-dcp" ||
                    plugin === "@mbarnett/opencode-dcp" ||
                    plugin.startsWith("@mbarnett/opencode-dcp@"))
            )
                continue
            plugins.push(plugin)
        }
        tui.plugin = plugins
        await writeFile(path, JSON.stringify(tui, null, 2) + "\n")
    }
    try {
        await writeFile(
            join(config, "dcp.jsonc"),
            JSON.stringify(
                {
                    $schema:
                        "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/main/dcp.schema.json",
                    autoUpdate: false,
                    debug: true,
                    pruneNotification: "off",
                },
                null,
                2,
            ) + "\n",
            { flag: "wx" },
        )
    } catch (error) {
        if (error.code !== "EEXIST") throw error
    }
    await restoreAuth(launch.major, "/input/auth.json", cli)
    const child = spawn(cli, [...launch.args, ...(launch.major === 1 ? [] : ["--standalone"])], {
        cwd: "/lab/project",
        stdio: "inherit",
        env: {
            ...process.env,
            OPENCODE_LOG_LEVEL: "DEBUG",
            ...(launch.major === 1 ? { OPENCODE_EXPERIMENTAL_WEBSOCKETS: "false" } : {}),
            REQUEST_LOG_DIR: raw,
        },
    })
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
    await relay.close()
    await readable.close()
}
