import childProcess from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"

export interface OriginalRecord {
    sourceId: string
    ref?: string
    role: string
    text: string
}

// OpenCode already installs ripgrep outside PATH on some hosts. Keep discovery
// and PATH changes within this one child process; explicit sgrep overrides win.
function searchRuntime() {
    const suffix = process.platform === "win32" ? ".exe" : ""
    const bins = [
        join(homedir(), ".cache", "opencode", "bin"),
        join(homedir(), ".local", "share", "opencode", "bin"),
        join(homedir(), ".cargo", "bin"),
        join(homedir(), ".local", "bin"),
    ]
    const binary = process.env.DCP_SGREP_BIN ||
        bins.map((bin) => join(bin, `sgrep${suffix}`)).find(existsSync) || "sgrep"
    const rgBin = bins.find((bin) => existsSync(join(bin, `rg${suffix}`)))
    const env = { ...process.env }
    if (rgBin) {
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH"
        env[pathKey] = [rgBin, env[pathKey]].filter(Boolean).join(delimiter)
    }
    return { binary, env }
}

// This receives only the already-redacted observable JSON used by dcp_read.
function sourceText(record: OriginalRecord): string {
    const parts = JSON.parse(record.text) as Array<Record<string, unknown>>
    return parts
        .flatMap((part) =>
            Object.entries(part).map(
                ([key, value]) =>
                    `${key}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`,
            ),
        )
        .join("\n")
        .replace(/\r\n?/g, "\n")
}

export async function searchWithSgrep(
    records: OriginalRecord[],
    query: string,
    limit: number,
    signal?: AbortSignal,
) {
    if (records.length === 0) return []
    signal?.throwIfAborted()
    const directory = await mkdtemp(join(tmpdir(), "dcp-sgrep-"))
    try {
        const sources = new Map<string, { record: OriginalRecord; lines: string[] }>()
        for (const [index, record] of records.entries()) {
            signal?.throwIfAborted()
            const file = join(directory, `source-${index}.txt`)
            const text = sourceText(record)
            await writeFile(file, text, { mode: 0o600 })
            sources.set(resolve(file), { record, lines: text.split("\n") })
        }
        // No shell, no global session directory, no persistent index containing source copies.
        // The ordinary sgrep model cache remains usable; first use may download model assets.
        const runtime = searchRuntime()
        const output = await new Promise<string>((accept, reject) => {
            childProcess.execFile(
                runtime.binary,
                ["--json", "-n", String(limit), "--model", "text", "--no-cache", "--", query, "."],
                {
                    cwd: directory,
                    env: runtime.env,
                    signal,
                    timeout: 120_000,
                    maxBuffer: 4 * 1024 * 1024,
                    encoding: "utf8",
                    windowsHide: true,
                },
                (error, stdout) => {
                    if (error) {
                        if (error.code === 1) return accept("[]")
                        return reject(
                            new Error(
                                `DCP semantic search failed (${error.code ?? "process error"}). Check DCP_SGREP_BIN/PATH, ripgrep, and sgrep model availability. No literal-search fallback was used.`,
                            ),
                        )
                    }
                    accept(stdout)
                },
            )
        })
        signal?.throwIfAborted()
        const hits: unknown = JSON.parse(output)
        if (!Array.isArray(hits)) throw new Error("DCP sgrep returned invalid JSON results")
        return hits.slice(0, limit).map((hit) => {
            const source =
                typeof hit?.path === "string"
                    ? sources.get(resolve(directory, hit.path))
                    : undefined
            if (
                !source ||
                !Number.isSafeInteger(hit.start) ||
                !Number.isSafeInteger(hit.end) ||
                hit.start < 1 ||
                hit.end < hit.start ||
                hit.end > source.lines.length
            )
                throw new Error(
                    "DCP sgrep returned a source outside the selected originals or an invalid line range",
                )
            return {
                sourceId: source.record.sourceId,
                ref: source.record.ref,
                role: source.record.role,
                lineStart: hit.start as number,
                lineEnd: hit.end as number,
                // Reconstruct from the selected original, not CLI-supplied content.
                text: source.lines
                    .slice(hit.start - 1, hit.end)
                    .join("\n")
                    .slice(0, 640),
            }
        })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}
