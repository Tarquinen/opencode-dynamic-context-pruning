import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createMock } from "./mock.mjs"
import { inspect } from "./inspect.mjs"
import { run } from "./process.mjs"
import { commands } from "./api.mjs"
import { authentication } from "./auth.mjs"

await run("npm", [
    "install",
    "--prefix",
    "/lab/plugins",
    "--omit=dev",
    "--ignore-scripts",
    "/artifacts/opencode-request-logger-0.1.0.tgz",
    "/artifacts/mbarnett-opencode-dcp-3.2.1.tgz",
])
console.log(JSON.stringify(await authentication()))
const logger = "/lab/plugins/node_modules/opencode-request-logger"
const dcp = "/lab/plugins/node_modules/@mbarnett/opencode-dcp"
const require = createRequire(join(logger, "package.json"))
const { WebSocketServer } = require("ws")
const { createRelay } = await import(pathToFileURL(join(logger, "relay.mjs")))
const mock = await createMock(WebSocketServer)
try {
    for (const [version, transport, mode] of [
        ["v2", "http", "range"],
        ["v2", "websocket", "range"],
        ["v2", "http", "message"],
        ["v2", "websocket", "message"],
        ["v1", "http", "range"],
        ["v1", "http", "message"],
    ]) {
        const root = `/lab/${version}-${transport}-${mode}`
        const directory = join(root, "project")
        const config = join(root, "config", "opencode")
        const logs = join(root, "logs")
        await Promise.all([directory, config, logs].map((path) => mkdir(path, { recursive: true })))
        const relay = createRelay({ directory: logs })
        await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve))
        try {
            const options = {
                directory: logs,
                relay: `ws://127.0.0.1:${relay.server.address().port}`,
            }
            const settings =
                version === "v2"
                    ? {
                          plugins: [{ package: dcp }, { package: logger, options }],
                          update: "disable",
                          model: "lab/gpt-5.4",
                          permissions: [{ action: "compress", resource: "*", effect: "allow" }],
                          providers: {
                              lab: {
                                  package: "@opencode/ai/providers/openai/responses",
                                  env: ["LAB_API_KEY"],
                                  settings: { baseURL: mock.url },
                                  models: {
                                      "gpt-5.4": {
                                          transport,
                                          compaction: { mode: "local" },
                                          limit: { context: 200000, output: 32000 },
                                      },
                                  },
                              },
                          },
                      }
                    : {
                          plugin: [dcp, logger],
                          autoupdate: false,
                          model: "lab/gpt-5.4",
                          small_model: "lab/gpt-5.4",
                          permission: { compress: "allow" },
                          provider: {
                              lab: {
                                  npm: "@ai-sdk/openai",
                                  options: { baseURL: mock.url, apiKey: "lab" },
                                  models: {
                                      "gpt-5.4": { limit: { context: 200000, output: 32000 } },
                                  },
                              },
                          },
                      }
            await writeFile(join(config, "opencode.json"), JSON.stringify(settings))
            if (version === "v1") {
                await writeFile(join(config, "tui.json"), JSON.stringify({ plugin: [dcp] }))
            }
            await writeFile(
                join(config, "dcp.json"),
                JSON.stringify({
                    autoUpdate: false,
                    debug: true,
                    pruneNotification: "off",
                    compress: { mode },
                }),
            )
            const env = {
                ...process.env,
                HOME: root,
                PWD: directory,
                XDG_CONFIG_HOME: join(root, "config"),
                XDG_DATA_HOME: join(root, "data"),
                XDG_STATE_HOME: join(root, "state"),
                XDG_CACHE_HOME: join(root, "cache"),
                OPENCODE_CONFIG_DIR: config,
                REQUEST_LOG_DIR: logs,
                LAB_API_KEY: "lab",
                OPENCODE_LOG_LEVEL: "DEBUG",
            }
            const cli =
                version === "v2"
                    ? "/opt/v2/node_modules/.bin/opencode2"
                    : "/opt/v1/node_modules/.bin/opencode"
            const start = mock.requests.length
            const output = await run(
                cli,
                [
                    "run",
                    ...(version === "v2" ? ["--standalone"] : []),
                    "--format",
                    "json",
                    "--model",
                    "lab/gpt-5.4",
                    "OLD_PAYLOAD: This completed material can be compressed. Then reply with MOCK_OK.",
                ],
                { cwd: directory, env, record: join(root, "run") },
            )
            assert.ok(output.includes("MOCK_OK"), "CLI did not return the mock response")
            const { captures, summary } = await inspect(logs)
            const sent = mock.requests
                .slice(start)
                .filter((request) => request.transport === transport)
            assert.ok(sent.length > 0, `${version} did not use ${transport}`)
            const recorded = captures.filter((entry) =>
                transport === "http"
                    ? entry.type === "http.request"
                    : entry.type === "ws.frame" && entry.direction === "request",
            )
            assert.equal(recorded.length, sent.length, "request capture missing or duplicated")
            for (const request of sent)
                assert.ok(
                    recorded.some(
                        (entry) => JSON.stringify(entry.body) === JSON.stringify(request.body),
                    ),
                    "wire request differs from captured body",
                )
            const primary = sent.filter((request) =>
                request.body.tools?.some((tool) => tool.name === "compress"),
            )
            assert.equal(
                primary.length,
                2,
                "compression must cause exactly one additional model step",
            )
            if (version === "v2") {
                assert.match(JSON.stringify(primary[0].body.input), /@1@/)
                for (const request of primary) {
                    assert.doesNotMatch(
                        JSON.stringify(request.body),
                        /dcp-message-id|mNNNN|m000\d|XML metadata/,
                    )
                }
                assert.match(
                    JSON.stringify(primary[1].body.input),
                    mode === "range" ? /@b1@/ : /@blocked@/,
                )
                if (mode === "message")
                    assert.match(JSON.stringify(primary[0].body.input), /@1@ \[low\]/)
            } else {
                assert.match(JSON.stringify(primary[0].body.input), /dcp-message-id/)
            }
            assert.match(JSON.stringify(primary[1].body.input), /LAB_SUMMARY/)
            assert.ok(
                !JSON.stringify(primary[1].body.input).includes("OLD_PAYLOAD"),
                "compressed source remains in wire context",
            )
            assert.ok(
                !primary[1].body.previous_response_id,
                "compression must reset the WebSocket continuation prefix",
            )
            const calls = primary[1].body.input
                .filter((item) => item.type === "function_call")
                .map((item) => item.call_id)
            const results = primary[1].body.input
                .filter((item) => item.type === "function_call_output")
                .map((item) => item.call_id)
            assert.deepEqual(results, calls, "tool calls/results must remain paired")
            if (transport === "http") {
                assert.equal(summary.httpRequests, summary.httpResponses)
                // OpenCode stops consuming at response.completed and can cancel
                // before the HTTP stream reaches EOF. Verify protocol completion.
                assert.equal(summary.httpResponses, summary.httpCompleted + summary.httpCancelled)
                for (const entry of recorded) {
                    const body = await readFile(
                        join(logs, entry.sessionID, `${entry.requestID}.response.body`),
                        "utf8",
                    )
                    const events = body
                        .split("\n")
                        .filter((line) => line.startsWith("data: "))
                        .map((line) => JSON.parse(line.slice(6)))
                    assert.ok(events.some((event) => event.type === "response.completed"))
                }
            } else assert.ok(summary.wsResponses > 0)
            if (version === "v2") assert.ok(summary.contexts > 0)
            const result = { version, transport, mode, compression: true, ...summary }
            if (version === "v2" && transport === "http" && mode === "range") {
                Object.assign(
                    result,
                    await commands(
                        cli,
                        { cwd: directory, env, record: join(root, "api") },
                        summary.sessions[0],
                    ),
                )
            }
            await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
            console.log(JSON.stringify(result))
        } finally {
            await relay.close()
        }
    }
} finally {
    await mock.close()
}
