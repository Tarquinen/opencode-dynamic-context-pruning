import { randomUUID } from "node:crypto"
import * as imageSize from "image-size"
import type { Plugin } from "@opencode/plugin"
import type { ContentPart } from "@opencode/ai/schema/messages"
import type { ToolContext } from "../compress/types"

// generate.text is text-only. Let the host decode attachments in an isolated,
// tool-free session; constructing Media.Asset here crosses the host's class boundary.
export function createSummarizer(ctx: Plugin.Context): NonNullable<ToolContext["summarizer"]> {
    return {
        models: async (signal) => (await ctx.model.list(undefined, { signal })).data,
        generate: async (input, signal) => {
            if (!input.images?.length) return ctx.generate.text(input, { signal })
            signal.throwIfAborted()
            const marker = `DCP_MEDIA_${randomUUID()}`
            const session = await ctx.session.create(
                {
                    title: "DCP image summarizer",
                    model: input.model,
                    permissions: [{ action: "*", resource: "*", effect: "deny" }],
                },
                { signal },
            )
            let calls = 0
            let imageTokens = 0
            let registration: { dispose(): Promise<void> } | undefined
            let interrupted: Promise<unknown> | undefined
            const abort = () => {
                interrupted = ctx.session.interrupt({ sessionID: session.id })
                // Consume an early rejection until finally awaits cleanup.
                void interrupted.catch(() => {})
            }
            signal.addEventListener("abort", abort, { once: true })
            try {
                registration = await ctx.session.hook("context", (event) => {
                    if (event.sessionID !== session.id) return
                    if (
                        ++calls !== 1 ||
                        event.model.providerID !== input.model.providerID ||
                        event.model.id !== input.model.id ||
                        (input.model.variant !== undefined &&
                            event.model.variant !== input.model.variant)
                    )
                        throw new Error("DCP isolated summarizer model or request count changed")
                    const images = event.messages
                        .filter(
                            (message) =>
                                message.role === "user" &&
                                message.content.some(
                                    (part) => part.type === "text" && part.text.includes(marker),
                                ),
                        )
                        .flatMap((message) =>
                            message.content.filter((part) => part.type === "media"),
                        )
                    if (images.length !== input.images!.length)
                        throw new Error("DCP native session did not load selected images")
                    imageTokens = estimateImageTokens(images)
                    if (
                        !Number.isFinite(input.imageTokenLimit) ||
                        imageTokens > input.imageTokenLimit!
                    )
                        throw new Error(
                            "DCP images exceed safe context budget; original context retained",
                        )
                    event.system = []
                    event.tools = {}
                    event.messages = [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: input.prompt },
                                ...images.flatMap((part, index) => [
                                    {
                                        type: "text" as const,
                                        text: `Image reference: ${input.images![index]!.ref}`,
                                    },
                                    part,
                                ]),
                            ],
                        },
                    ]
                })
                signal.throwIfAborted()
                await ctx.session.prompt(
                    {
                        sessionID: session.id,
                        text: marker,
                        files: input.images.map((image) => ({
                            uri: image.uri,
                            description: image.ref,
                        })),
                        resume: true,
                    },
                    { signal },
                )
                await ctx.session.wait({ sessionID: session.id }, { signal })
                signal.throwIfAborted()
                const entries = await ctx.session.context({ sessionID: session.id }, { signal })
                const assistants = entries.filter((entry) => entry.type === "assistant")
                const text = assistants
                    .flatMap((entry) =>
                        entry.content
                            .filter((part) => part.type === "text")
                            .map((part) => part.text),
                    )
                    .join("")
                if (
                    calls !== 1 ||
                    !text.trim() ||
                    assistants.some((entry) =>
                        entry.content.some((part) => part.type === "tool"),
                    ) ||
                    entries.some((entry) => entry.type === "idle" && entry.outcome !== "succeeded")
                )
                    throw new Error(
                        "DCP native image summarizer did not complete a tool-free response",
                    )
                return { text, imageTokens }
            } finally {
                signal.removeEventListener("abort", abort)
                try {
                    await interrupted
                    await ctx.session.interrupt({ sessionID: session.id })
                } finally {
                    try {
                        await registration?.dispose()
                    } finally {
                        await ctx.session.remove({ sessionID: session.id })
                    }
                }
            }
        },
    }
}

// Native attachment loading has decoded the image before this hook. Estimate
// from actual dimensions, not compressed byte size; keep a generous margin for
// different providers' patch/tile tokenizers. This is a guard, not a billing count.
export function estimateImageTokens(parts: ContentPart[]): number {
    let total = 0
    for (const part of parts) {
        if (part.type !== "media") continue
        const inline = part.media.inline()
        if (!inline) throw new Error("DCP image dimensions unavailable; original context retained")
        const { width, height } = imageSize.imageSize(Buffer.from(inline.base64, "base64"))
        if (!(width > 0 && height > 0))
            throw new Error("DCP image dimensions unavailable; original context retained")
        total += Math.ceil(width / 16) * Math.ceil(height / 16) * 4 + 1024
    }
    return total
}
