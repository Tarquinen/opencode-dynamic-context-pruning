import assert from "node:assert/strict"
import test from "node:test"
import { setup } from "../lib/v2/tui"

test("OpenCode v2 TUI setup registers /dcp-compress in the slash palette", async () => {
    const commands: Array<{
        id: string
        slash?: { name: string }
        run: (input?: string) => Promise<void>
    }> = []
    const dispatched: Array<{ sessionID: string; name: string; text: string }> = []

    await setup({
        location: { directory: "D:/repo" },
        data: { location: { default: () => ({ directory: "D:/repo" }) } },
        client: {
            rpc() {
                return {
                    async status() {
                        return { enabled: true }
                    },
                }
            },
            session: {
                async command(input: { sessionID: string; name: string; text: string }) {
                    dispatched.push(input)
                },
            },
        },
        renderer: {},
        theme: {},
        ui: {
            dialog: {
                set() {},
                show() {},
                clear() {},
            },
            router: {
                current: () => ({ type: "session", sessionID: "ses_live" }),
            },
            slot(input: { render: () => unknown }) {
                input.render()
            },
        },
        keymap: {
            layer(definition: () => { commands: typeof commands }) {
                commands.push(...definition().commands)
            },
        },
    } as never)

    const compress = commands.find((command) => command.slash?.name === "dcp-compress")
    assert.ok(compress, "expected /dcp-compress slash command")
    assert.equal(commands.some((command) => command.slash?.name === "dcp"), true)

    await compress.run("preserve the migration notes")
    assert.deepEqual(dispatched, [
        {
            sessionID: "ses_live",
            name: "dcp-compress",
            text: "preserve the migration notes",
        },
    ])
})
