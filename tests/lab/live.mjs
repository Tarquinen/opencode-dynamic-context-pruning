import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { inspect } from "./inspect.mjs"
import { run } from "./process.mjs"
import { restoreAuth } from "/sandbox/auth.mjs"

await run("npm", [
    "install",
    "--prefix",
    "/lab/plugins",
    "--omit=dev",
    "--ignore-scripts",
    "/artifacts/opencode-request-logger-0.1.0.tgz",
    "/artifacts/mbarnett-opencode-dcp-3.2.1.tgz",
])
const logger = "/lab/plugins/node_modules/opencode-request-logger"
const dcp = "/lab/plugins/node_modules/@mbarnett/opencode-dcp"
const { createRelay } = await import(pathToFileURL(join(logger, "relay.mjs")))
const root = "/lab/live"
const directory = join(root, "project")
const config = join(root, "config/opencode")
const cli = "/opt/v2/node_modules/.bin/opencode2"
const env = {
    ...process.env,
    HOME: root,
    PWD: directory,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_LOG_LEVEL: "DEBUG",
}
await Promise.all([directory, config].map((path) => mkdir(path, { recursive: true })))
for (const transport of ["http", "websocket"]) {
    const logs = join(root, transport, "logs")
    await mkdir(logs, { recursive: true })
    const relay = createRelay({ directory: logs })
    await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve))
    try {
        await writeFile(
            join(config, "opencode.json"),
            JSON.stringify({
                update: "disable",
                model: "openai/gpt-5.6-sol",
                plugins: [
                    { package: dcp },
                    {
                        package: logger,
                        options: {
                            directory: logs,
                            relay: `ws://127.0.0.1:${relay.server.address().port}`,
                        },
                    },
                ],
                permissions: [{ action: "compress", resource: "*", effect: "allow" }],
                providers: {
                    openai: {
                        models: { "gpt-5.6-sol": { transport } },
                    },
                },
            }),
        )
        await writeFile(
            join(config, "dcp.json"),
            JSON.stringify({ autoUpdate: false, debug: true, pruneNotification: "off" }),
        )
        if (transport === "http") await restoreAuth(2, "/artifacts/auth.json", cli, env)
        const prompt =
            "LIVE_RAW_PAYLOAD: We are testing DCP in an isolated environment. Everything in this user message is disposable test content. Call compress exactly once on this message using its injected message ID, with summary 'DCP_LIVE_SUMMARY: disposable test fixture. Compression is done; reply with exactly DCP_LIVE_OK and do not use more tools.' After the tool completes, reply with exactly DCP_LIVE_OK. Do not use other tools."
        const output = await run(
            cli,
            ["run", "--standalone", "--format", "json", "--model", "openai/gpt-5.6-sol", prompt],
            {
                cwd: directory,
                record: join(root, transport, "run"),
                env,
            },
        )
        const { captures, summary } = await inspect(logs)
        const requests = captures
            .filter(
                (entry) =>
                    entry.kind === "primary" &&
                    (transport === "http"
                        ? entry.type === "http.request"
                        : entry.type === "ws.frame" && entry.direction === "request"),
            )
            .map((entry) => entry.body)
        assert.ok(
            requests.length >= 2,
            "Live compression did not produce a follow-up model request",
        )
        assert.ok(
            requests.some(
                (body) =>
                    JSON.stringify(body.input).includes("DCP_LIVE_SUMMARY") &&
                    !JSON.stringify(body.input).includes("LIVE_RAW_PAYLOAD"),
            ),
            "Live compression did not replace the original content on the wire",
        )
        const state = JSON.parse(
            await readFile(
                join(root, "data/opencode/storage/plugin/dcp", `${summary.sessions[0]}.json`),
                "utf8",
            ),
        )
        assert.equal(state.prune.messages.activeBlockIds.length, 1)
        const result = {
            transport,
            ...summary,
            reply: output
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .some(
                    (entry) => entry.type === "text" && entry.part?.text.trim() === "DCP_LIVE_OK",
                ),
            compression: true,
        }
        await writeFile(join(root, transport, "result.json"), JSON.stringify(result, null, 2))
        console.log(JSON.stringify(result))
        assert.ok(
            result.reply,
            "Live model did not return the expected reply; inspect isolated run output",
        )
        assert.ok(
            captures.some(
                (entry) =>
                    entry.kind === "primary" &&
                    (transport === "http"
                        ? entry.type === "http.request"
                        : entry.type === "ws.frame" && entry.direction === "request"),
            ),
            `Live ${transport} traffic was not captured`,
        )
    } finally {
        await relay.close()
    }
}
