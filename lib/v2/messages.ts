import type { Message, ContentPart, ToolResultPart } from "@opencode/ai/schema/messages"
import type { Plugin } from "@opencode/plugin"
import type { WithParts } from "../state"
import { isDcpChatText } from "../ui/utils"

type History = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
type Session = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type Part = WithParts["parts"][number]

const emptyUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function info(id: string, role: string, session: Session, entry?: History[number]) {
    const model = entry?.type === "assistant" ? entry.model : session.model
    return {
        id,
        role,
        sessionID: session.id,
        time: { created: entry?.time.created ?? 0 },
        agent: entry?.type === "assistant" ? entry.agent : session.agent,
        model: { providerID: model?.providerID, modelID: model?.id, variant: model?.variant },
        providerID: model?.providerID,
        modelID: model?.id,
        tokens: entry?.type === "assistant" ? (entry.tokens ?? emptyUsage) : emptyUsage,
        summary: entry?.type === "compaction" && entry.status === "completed",
    } as unknown as WithParts["info"]
}

// Bookkeeping projections are never sent to a provider. Native messages remain
// authoritative for reasoning, media, checkpoints, and provider metadata.
export function history(entries: History, session: Session): WithParts[] {
    return entries.flatMap((entry): WithParts[] => {
        const base = { sessionID: session.id, messageID: entry.id }
        if (entry.type === "assistant") {
            const parts = entry.content.map((part, index) => {
                if (part.type !== "tool")
                    return { ...base, id: `${entry.id}:${index}`, type: part.type, text: part.text }
                const state = part.state
                return {
                    ...base,
                    id: part.id,
                    type: "tool",
                    callID: part.id,
                    tool: part.name,
                    state: {
                        ...state,
                        input: structuredClone(state.input),
                        ...(state.status === "completed" ? { output: output(state.content) } : {}),
                    },
                }
            })
            return [
                {
                    info: info(entry.id, "assistant", session, entry),
                    parts: [{ ...base, id: `${entry.id}:step`, type: "step-start" }, ...parts],
                } as WithParts,
            ]
        }
        let text: string | undefined
        if (entry.type === "user") {
            // DCP chat notifications are UI-only; they never reach the state
            // view that decides compression.
            if (isDcpChatText(entry.text)) return []
            text = [
                ...(entry.skills ?? []).flatMap((skill) =>
                    skill.text === undefined ? [] : [skill.text],
                ),
                entry.text,
            ].join("\n\n")
        }
        if (entry.type === "synthetic" || entry.type === "skill") text = entry.text
        if (entry.type === "location-switched")
            text = `The working directory has been changed to ${entry.location.directory}.`
        if (entry.type === "shell" && entry.metadata?.background !== true)
            text = `The following shell command was executed by the user:\n\nCommand:\n${entry.command}\n\nOutput:\n${entry.output?.output ?? ""}`
        if (text !== undefined) {
            return [
                {
                    info: info(entry.id, "user", session, entry),
                    parts: [{ ...base, id: `${entry.id}:text`, type: "text", text }],
                } as WithParts,
            ]
        }
        if (entry.type === "compaction" && entry.status === "completed") {
            return [{ info: info(entry.id, "assistant", session, entry), parts: [] } as WithParts]
        }
        return []
    })
}

function output(content: ReadonlyArray<{ type: string; text?: string }>): unknown {
    return content.length === 1 && content[0]?.type === "text"
        ? content[0].text
        : structuredClone(content)
}

export function project(native: Message[], entries: History, session: Session) {
    const byID = new Map(entries.map((entry) => [entry.id, entry]))
    const results = new Map<string, ToolResultPart>()
    const owners = new Map<string, string>()
    const links = new Map<ContentPart, Part>()
    const originals = new Map<string, WithParts>()
    const messages: WithParts[] = []
    for (const message of native)
        for (const part of message.content) {
            if (part.type === "tool-result") results.set(part.id, part)
            if (part.type === "tool-call" && message.id) owners.set(part.id, message.id)
        }
    for (const message of native) {
        if (!message.id || !["user", "assistant"].includes(message.role)) continue
        const entry = byID.get(message.id)
        if (!entry || entry.type === "compaction") continue
        const base = { sessionID: session.id, messageID: message.id }
        const parts: Part[] = []
        if (message.role === "assistant")
            parts.push({ ...base, id: `${message.id}:step`, type: "step-start" })
        for (const [index, part] of message.content.entries()) {
            let projected: Part | undefined
            if (part.type === "text") {
                // DCP chat notifications (and any host-marked ignored text)
                // are projected but flagged, so restore() can drop them from
                // the request. They must stay linked, otherwise restore() would
                // pass the native part through verbatim.
                const dropped =
                    message.role === "user" &&
                    (isDcpChatText(part.text) ||
                      (part as { ignored?: boolean }).ignored === true)
                projected = {
                    ...base,
                    id: `${message.id}:${index}`,
                    type: "text",
                    text: part.text,
                    ...(dropped ? { ignored: true } : {}),
                }
            }
            if (part.type === "media") {
                const inline = part.media.inline()
                projected = {
                    ...base,
                    id: `${message.id}:${index}`,
                    type: "file",
                    mime: part.media.mediaType,
                    url: inline?.dataUrl ?? "",
                }
            }
            if (part.type === "tool-call") {
                const result = results.get(part.id)
                const entry = byID.get(message.id)
                const durable =
                    entry?.type === "assistant"
                        ? entry.content.find((item) => item.type === "tool" && item.id === part.id)
                        : undefined
                projected = {
                    ...base,
                    id: part.id,
                    type: "tool",
                    callID: part.id,
                    tool: part.name,
                    state: {
                        status: !result
                            ? "running"
                            : result.result.type === "error"
                              ? "error"
                              : "completed",
                        input: structuredClone(part.input),
                        ...(result?.result.type === "error"
                            ? { error: result.result.value }
                            : {
                                  output: structuredClone(
                                      result?.result.type === "text"
                                          ? result.result.value
                                          : result?.result,
                                  ),
                              }),
                        metadata:
                            durable?.type === "tool" && "metadata" in durable.state
                                ? durable.state.metadata
                                : {},
                    },
                } as Part
                if (result) links.set(result, projected)
            }
            if (projected) {
                parts.push(projected)
                links.set(part, projected)
            }
        }
        const projected = {
            info: info(message.id, message.role, session, byID.get(message.id)),
            parts,
        } as WithParts
        messages.push(projected)
        originals.set(message.id, projected)
    }

    function restore(): Message[] {
        const retained = new Set(messages.map((message) => message.info.id))
        const linked = new Set(links.values())
        const output: Message[] = []
        let next = 0
        const synthetic = () => {
            while (next < messages.length && !originals.has(messages[next]!.info.id)) {
                const message = messages[next++]!
                output.push({
                    id: message.info.id,
                    role: "user",
                    content: message.parts
                        .filter((part) => part.type === "text")
                        .map((part) => ({ type: "text", text: part.text })),
                })
            }
        }
        for (const message of native) {
            const projected = message.id ? originals.get(message.id) : undefined
            if (projected) {
                synthetic()
                if (!retained.has(message.id!)) continue
                next++
            }
            const content: ContentPart[] = []
            const added =
                projected?.parts.flatMap((part) =>
                    part.type === "text" && !linked.has(part)
                        ? [{ type: "text" as const, text: part.text }]
                        : [],
                ) ?? []
            for (const part of message.content) {
                if (part.type === "tool-call") content.push(...added.splice(0))
                if (
                    part.type === "tool-result" &&
                    originals.has(owners.get(part.id)!) &&
                    !retained.has(owners.get(part.id)!)
                )
                    continue
                const edit = links.get(part)
                if (part.type === "text" && edit?.type === "text") {
                    if (edit.ignored) continue
                    content.push({ ...part, text: edit.text })
                } else if (part.type === "tool-call" && edit?.type === "tool")
                    content.push({ ...part, input: edit.state.input })
                else if (
                    part.type === "tool-result" &&
                    edit?.type === "tool" &&
                    edit.state.status === "completed" &&
                    typeof edit.state.output === "string" &&
                    edit.state.output !== part.result.value
                ) {
                    content.push({ ...part, result: { type: "text", value: edit.state.output } })
                } else content.push(part)
            }
            content.push(...added)
            if (content.length || message.content.length === 0) output.push({ ...message, content })
        }
        synthetic()
        return output
    }
    // A native checkpoint can replace every user message. Summary construction
    // still needs session/agent/model fields, without projecting that checkpoint.
    const summaryBase: WithParts = { info: info("msg_dcp_base", "user", session), parts: [] }
    return { messages, restore, summaryBase }
}
