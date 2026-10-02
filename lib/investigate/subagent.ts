import type { CompressionBlock } from "../state"
import type { Logger } from "../logger"

function unwrapSession(value: any): any {
    return value?.data ?? value
}

function extractAssistantText(result: any): string {
    const data = unwrapSession(result)
    const parts = Array.isArray(data?.parts) ? data.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
            texts.push(part.text.trim())
        }
    }
    return texts.join("\n").trim()
}

function lastAssistantText(messagesResponse: any): string {
    const data = unwrapSession(messagesResponse)
    const list = Array.isArray(data) ? data : []
    for (let i = list.length - 1; i >= 0; i--) {
        const message = list[i]
        const info = message?.info ?? message
        if (info?.role !== "assistant") {
            continue
        }
        const parts = Array.isArray(message?.parts) ? message.parts : []
        for (let j = parts.length - 1; j >= 0; j--) {
            const part = parts[j]
            if (
                part?.type === "text" &&
                typeof part.text === "string" &&
                part.text.trim().length > 0
            ) {
                return part.text.trim()
            }
        }
    }
    return ""
}

export async function runInvestigation(
    client: any,
    logger: Logger,
    parentSessionId: string,
    block: CompressionBlock,
    blockRef: string,
    question: string,
    content: string,
): Promise<string> {
    const prompt = [
        "You are a subagent answering a question about a section of a conversation that was compressed.",
        `The section was compressed into block ${blockRef}${block.topic ? ` (topic: ${block.topic})` : ""}.`,
        "Below is the ORIGINAL, un-compressed content of that section.",
        "",
        "--- BEGIN ORIGINAL CONTENT ---",
        content,
        "--- END ORIGINAL CONTENT ---",
        "",
        `Question: ${question}`,
        "",
        "Answer the question using ONLY the provided content. Do not use any tools. Return only the answer, with no preamble, no caveats about the content being a summary, and no explanation of your process.",
    ].join("\n")

    let child: any
    try {
        const created = await client.session.create({
            body: {
                parentID: parentSessionId,
                title: `dcp investigate ${blockRef}`,
            },
        })
        child = unwrapSession(created)
        const childId = child?.id
        if (!childId) {
            throw new Error("Failed to create investigation sub-session")
        }

        const result = await client.session.prompt({
            path: { id: childId },
            body: {
                parts: [{ type: "text", text: prompt }],
            },
        })

        let answer = extractAssistantText(result)
        if (!answer) {
            const messagesResponse = await client.session.messages({ path: { id: childId } })
            answer = lastAssistantText(messagesResponse)
        }
        return answer || "(no answer produced)"
    } catch (error: any) {
        logger.error("Investigation subagent failed", { error: error?.message ?? String(error) })
        throw new Error(`Investigation failed: ${error?.message ?? String(error)}`)
    } finally {
        if (child?.id) {
            try {
                await client.session.delete({ path: { id: child.id } })
            } catch {
                // best-effort cleanup
            }
        }
    }
}
