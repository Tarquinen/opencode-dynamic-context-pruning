export interface MediaSource {
    uri: string
    mime: string
}

function mapJson(text: string, reference: (source: MediaSource) => string): string | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return
    }
    if (!parsed || typeof parsed !== "object") return
    let changed = false
    const mapped = mapMedia(parsed, (source) => {
        changed = true
        return reference(source)
    })
    return changed ? JSON.stringify(mapped) : text
}

// Tool output and protected content can wrap JSON in prose or Markdown fences.
// Locate balanced fragments while respecting quoted braces and escaped quotes.
function mapEmbeddedJson(text: string, reference: (source: MediaSource) => string): string {
    const starts: number[] = []
    const ends = new Map<number, number>()
    const stack: number[] = []
    let quoted = false
    for (let index = 0; index < text.length; index++) {
        const char = text[index]
        if (quoted && char === "\\") {
            index++
            continue
        }
        if (stack.length && char === '"') quoted = !quoted
        if (quoted) continue
        if (char === "{" || char === "[") {
            starts.push(index)
            stack.push(index)
        } else if (char === "}" || char === "]") {
            const start = stack.pop()
            if (start !== undefined) ends.set(start, index + 1)
        }
    }
    let result = ""
    let copied = 0
    for (const start of starts) {
        if (start < copied) continue
        const end = ends.get(start)
        if (end === undefined) continue
        const mapped = mapJson(text.slice(start, end), reference)
        if (mapped === undefined) continue
        result += text.slice(copied, start) + mapped
        copied = end
    }
    return result + text.slice(copied)
}

// Handles native file parts, MCP images and images embedded in JSON/text results.
// The callback receives payloads before redaction or tokenization can corrupt them.
export function mapMedia(value: unknown, reference: (source: MediaSource) => string): unknown {
    if (typeof value === "string") {
        if (/^\s*[\[{]/.test(value)) {
            const mapped = mapJson(value, reference)
            if (mapped !== undefined) return mapped
        }
        return mapEmbeddedJson(value, reference).replace(
            /data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[^;,\s]+)*;base64,[A-Za-z0-9+/]+={0,2}/gi,
            (uri, mime: string) => reference({ uri, mime: mime.toLowerCase() }),
        )
    }
    if (Array.isArray(value)) return value.map((item) => mapMedia(item, reference))
    if (!value || typeof value !== "object") return value
    const item = value as Record<string, unknown>
    const mime = item.mime ?? item.mimeType ?? item.mediaType
    let uri = item.uri ?? item.url
    if (item.type === "image" && typeof item.data === "string" && typeof mime === "string")
        uri = `data:${mime};base64,${item.data}`
    if (item.type === "image_url") {
        const image = item.image_url
        uri = typeof image === "string" ? image : (image as { url?: unknown })?.url
    }
    if (
        (item.type === "file" || item.type === "image" || item.type === "image_url") &&
        typeof uri === "string"
    ) {
        const mediaType =
            typeof mime === "string"
                ? mime
                : (/^data:([^;,]+)/i.exec(uri)?.[1] ??
                  (item.type === "file" ? "application/octet-stream" : "image/*"))
        return {
            type: "media-reference",
            mime: mediaType,
            ref: reference({ uri, mime: mediaType }),
            ...(typeof item.name === "string" ? { name: item.name } : {}),
        }
    }
    return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [key, mapMedia(entry, reference)]),
    )
}

export function mediaTokenText(value: unknown): string {
    const mapped = mapMedia(value, ({ mime }) => `[${mime} attachment]`)
    return typeof mapped === "string" ? mapped : JSON.stringify(mapped)
}
