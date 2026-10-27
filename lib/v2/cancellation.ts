// OpenCode 2.0.26's native Promise tool Context includes signal. SDK 2.0.4's
// declarations omit it; inspect this runtime capability rather than wrapping
// the whole plugin in an older, incompatible Effect/endpoint adapter.
export function nativeToolSignal(context: unknown): AbortSignal | undefined {
    if (!context || typeof context !== "object") return undefined
    const signal = (context as { signal?: unknown }).signal
    if (
        !signal ||
        typeof signal !== "object" ||
        typeof (signal as AbortSignal).throwIfAborted !== "function" ||
        typeof (signal as AbortSignal).addEventListener !== "function" ||
        typeof (signal as AbortSignal).aborted !== "boolean"
    )
        return undefined
    return signal as AbortSignal
}
