/**
 * Normalizes model-emitted `content` arguments for the compress tools.
 *
 * Some models emit `content` as a single entry object or a JSON-encoded string
 * instead of the required array of entry objects. When the intent is
 * unambiguous we coerce it into the array form; when the payload is a plain
 * string (a summary with no range boundaries) we throw a guiding error that
 * tells the model exactly how to re-send the call.
 *
 * `coerceContentArray` does not check the shape of array elements; call sites
 * chain the tool's `validateArgs`, which reports the specific missing field.
 */

export const NON_EMPTY_ARRAY_ERROR_MESSAGE = "content is required and must be a non-empty array"

export function isStringFields(value: unknown, keys: readonly string[]): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false
    }
    const record = value as Record<string, unknown>
    return keys.every((key) => typeof record[key] === "string")
}

export function coerceContentArray<T>(
    raw: unknown,
    isEntry: (value: unknown) => value is T,
    guidance: string,
): T[] {
    if (Array.isArray(raw)) {
        return raw as T[]
    }

    if (typeof raw === "string") {
        const trimmed = raw.trim()
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
            let parsed: unknown
            try {
                parsed = JSON.parse(trimmed)
            } catch {
                parsed = undefined
            }
            if (Array.isArray(parsed)) {
                if (parsed.length === 0) {
                    throw new Error(NON_EMPTY_ARRAY_ERROR_MESSAGE)
                }
                return parsed as T[]
            }
            if (isEntry(parsed)) {
                return [parsed]
            }
        }
        throw new Error(`content must be a JSON array, not a plain string. ${guidance}`)
    }

    if (raw !== null && typeof raw === "object" && isEntry(raw)) {
        return [raw as T]
    }

    throw new Error(NON_EMPTY_ARRAY_ERROR_MESSAGE)
}

export interface CompressArgsSpec<TEntry> {
    isEntry: (value: unknown) => value is TEntry
    contentNoun: string
    shapeExample: string
    contentGuidance: string
}

export function normalizeCompressArgs<TEntry>(
    args: unknown,
    spec: CompressArgsSpec<TEntry>,
): { topic: string; content: TEntry[] } {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(
            `compress takes a JSON object with "topic" (string) and "content" (array of ${spec.contentNoun}). ` +
                `Re-send as: ${spec.shapeExample}`,
        )
    }
    const { topic, content } = args as Record<string, unknown>
    return {
        topic: topic as string,
        content: coerceContentArray(content, spec.isEntry, spec.contentGuidance),
    }
}
