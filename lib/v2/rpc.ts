import { tool } from "@opencode-ai/plugin"

const z = tool.schema
const session = z.object({ sessionID: z.string() })
const stats = z.object({
    sessionTokens: z.number(),
    sessionSummaryTokens: z.number(),
    sessionDurationMs: z.number(),
    sessionTools: z.number(),
    sessionMessages: z.number(),
    allTime: z.object({
        totalTokens: z.number(),
        totalTools: z.number(),
        totalMessages: z.number(),
        sessionCount: z.number(),
    }),
})
const context = z.object({
    system: z.number(),
    user: z.number(),
    assistant: z.number(),
    tools: z.number(),
    toolCount: z.number(),
    toolsInContextCount: z.number(),
    prunedTokens: z.number(),
    prunedToolCount: z.number(),
    prunedMessageCount: z.number(),
    total: z.number(),
})

export const rpc = {
    id: "dcp",
    methods: {
        status: { input: z.object({}), output: z.object({ enabled: z.boolean() }) },
        snapshot: {
            input: session,
            output: z.object({
                manualMode: z.boolean(),
                canCompress: z.boolean(),
                blockedReason: z.string().optional(),
                context,
                stats,
            }),
        },
        manual: { input: session.extend({ enabled: z.boolean() }), output: z.object({}) },
    },
    // Server -> TUI notifications (prune/compress reports, command output).
    // Ephemeral by design: nothing is stored, nothing enters model context.
    events: {
        notify: {
            schema: z.object({
                title: z.string(),
                message: z.string(),
                variant: z.enum(["info", "success", "warning", "error"]).optional(),
                duration: z.number().optional(),
            }),
        },
    },
} as const
