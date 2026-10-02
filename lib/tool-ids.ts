import type { WithParts } from "./state"

type ToolPart = Extract<WithParts["parts"][number], { type: "tool" }>

export function getAmbiguousToolIds(messages: WithParts[]): Set<string> {
    const seen = new Set<string>()
    const ambiguous = new Set<string>()
    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) continue
            if (seen.has(part.callID)) ambiguous.add(part.callID)
            seen.add(part.callID)
        }
    }
    return ambiguous
}

export function toolOccurrenceKey(message: WithParts, part: ToolPart): string {
    return JSON.stringify([message.info.id, part.id ?? part.callID])
}
