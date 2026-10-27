import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "dcp-readback-hosts-"))
process.env.XDG_CONFIG_HOME = root
process.env.XDG_DATA_HOME = root
process.env.OPENCODE_CONFIG_DIR = root
writeFileSync(
    join(root, "dcp.jsonc"),
    JSON.stringify({ autoUpdate: false, debug: false, compress: { permission: "deny" } }),
)
after(() => rmSync(root, { recursive: true, force: true }))
const { setup } = await import("../lib/v2")
const plugin = (await import("../index")).default

test("V1 registers readback independently of compress and adds no allow permission", async () => {
    const hooks = await plugin.server({ directory: root, client: {} } as never)
    assert.ok(hooks.tool?.dcp_read)
    assert.equal(hooks.tool?.compress, undefined)
    const config = { permission: { "*": "deny", dcp_read: "ask" } }
    await hooks.config!(config as never)
    assert.equal(config.permission.dcp_read, "ask")
    assert.equal(config.permission["*"], "deny")
})

test("V2 registers a callable current-session tool and enforces native permissions before reads", async () => {
    const tools: Record<string, any> = {}
    const reads: string[] = []
    const permissions: unknown[] = []
    let denied = false
    let parentID: string | undefined
    const host = {
        location: { directory: root },
        rpc: { register: async () => {} },
        model: { transform: async (callback: any) => callback({ list: () => [] }) },
        tool: {
            transform: async (callback: any) =>
                callback({
                    add: (tool: any) => {
                        tools[tool.name] = tool
                    },
                }),
        },
        command: { transform: async () => {} },
        session: {
            hook: async () => {},
            get: async ({ sessionID }: any) => {
                reads.push(`get:${sessionID}`)
                return { id: sessionID, parentID }
            },
            context: async ({ sessionID }: any) => {
                reads.push(`context:${sessionID}`)
                return [
                    {
                        type: "user",
                        id: "native_source",
                        text: "NATIVE_ORIGINAL",
                        time: { created: 1 },
                    },
                ]
            },
        },
        permission: {
            assert: async (input: unknown) => {
                permissions.push(input)
                if (denied) throw new Error("host denied")
            },
        },
    }
    const dispose = await setup(host as never)
    const definition = tools.dcp_read
    assert.ok(definition)
    assert.equal(definition.options.permission, "dcp_read")
    assert.equal(tools.compress, undefined)
    const context = {
        sessionID: "ses_native",
        messageID: "msg_read",
        id: "call_read",
        agent: "build",
        signal: new AbortController().signal,
        progress: async () => {},
    }
    denied = true
    await assert.rejects(definition.execute({ startId: "native_source" }, context), /host denied/)
    assert.deepEqual(reads, [])
    denied = false
    const result = await definition.execute({ startId: "native_source" }, context)
    const page = JSON.parse(result.content)
    assert.equal(page.sources[0].sourceId, "native_source")
    assert.equal(page.sources[0].role, "user")
    assert.match(page.sources[0].text, /NATIVE_ORIGINAL/)
    assert.ok(reads.every((read) => read.endsWith(":ses_native")))
    assert.deepEqual(permissions[1], {
        sessionID: "ses_native",
        agent: "build",
        action: "dcp_read",
        resources: ["*"],
        source: { type: "tool", messageID: "msg_read", id: "call_read" },
    })
    parentID = "ses_parent"
    reads.length = 0
    await assert.rejects(
        definition.execute({ startId: "native_source" }, context),
        /disabled in subagents/,
    )
    assert.deepEqual(reads, ["get:ses_native"])
    parentID = undefined
    delete (host as any).permission
    reads.length = 0
    await assert.rejects(
        definition.execute({ startId: "native_source" }, context),
        /permission.assert support/,
    )
    assert.deepEqual(reads, [])
    dispose?.()
})
