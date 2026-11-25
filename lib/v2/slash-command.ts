export interface DcpSlashRoute {
    readonly type: string
    readonly sessionID?: string
}

export async function dispatchDcpServerCommand(input: {
    readonly route: DcpSlashRoute
    readonly name: "dcp" | "dcp-compress"
    readonly text: string | undefined
    readonly command: (input: { sessionID: string; name: string; text: string }) => Promise<unknown>
    readonly open: () => Promise<void> | void
    readonly fail: (cause: unknown) => void
}): Promise<void> {
    if (input.route.type !== "session" || !input.route.sessionID) {
        await input.open()
        return
    }

    try {
        await input.command({
            sessionID: input.route.sessionID,
            name: input.name,
            text: input.text ?? "",
        })
    } catch (cause) {
        input.fail(cause)
    }
}
