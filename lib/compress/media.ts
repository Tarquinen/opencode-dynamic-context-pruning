import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import * as imageSize from "image-size"
import { mapMedia, type MediaSource } from "../media"
import type { SummaryImage } from "./types"

const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
}

export class CompressionMedia {
    private assets = new Map<string, SummaryImage & { bytes?: Buffer }>()

    transform(value: unknown): unknown {
        return mapMedia(value, (source) => this.reference(source))
    }

    private reference({ uri, mime }: MediaSource): string {
        const previous = this.assets.get(uri)
        if (previous) return previous.ref
        let ref = uri
        let bytes: Buffer | undefined
        if (/^data:/i.test(uri)) {
            const match =
                /^data:([^;,]+)(?:;[\w.+-]+=[^;,\s]+)*;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri)
            if (!match) throw new Error("DCP invalid inline media; original context retained")
            mime = match[1]!.toLowerCase()
            bytes = Buffer.from(match[2]!, "base64")
            if (
                !bytes.length ||
                bytes.toString("base64").replace(/=+$/, "") !== match[2]!.replace(/=+$/, "")
            )
                throw new Error("DCP invalid media encoding; original context retained")
            const digest = createHash("sha256").update(bytes).digest("hex")
            ref = join(
                process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
                "opencode",
                "storage",
                "plugin",
                "dcp",
                "media",
                `${digest}.${extensions[mime] ?? "bin"}`,
            )
        }
        if (!ref)
            throw new Error("DCP media has no retrievable reference; original context retained")
        this.assets.set(uri, { ref, mime, uri, bytes })
        return ref
    }

    images(): SummaryImage[] {
        return [...new Map([...this.assets.values()].map((asset) => [asset.ref, asset])).values()]
            .filter((asset) => {
                if (!asset.mime.startsWith("image/")) return false
                if (!asset.bytes) return true
                // Logs can contain test data labelled as an image. The host loads
                // non-image bytes as text; retain their reference without attaching them.
                try {
                    const { width, height } = imageSize.imageSize(asset.bytes)
                    return width > 0 && height > 0
                } catch {
                    return false
                }
            })
            .map(({ ref, mime, uri }) => ({ ref, mime, uri }))
    }

    async save(): Promise<void> {
        for (const { ref, bytes } of this.assets.values()) {
            if (!bytes) continue
            await mkdir(join(ref, ".."), { recursive: true, mode: 0o700 })
            try {
                await writeFile(ref, bytes, { flag: "wx", mode: 0o600 })
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                if (!(await readFile(ref)).equals(bytes))
                    throw new Error(
                        "DCP stored media differs from original; original context retained",
                    )
            }
        }
    }

    appendReferences(summary: string, inspected: boolean): string {
        if (!this.assets.size) return summary
        const refs = [
            ...new Map([...this.assets.values()].map((asset) => [asset.ref, asset])).values(),
        ]
        return (
            summary +
            "\n\nMedia references retained (" +
            (inspected
                ? "images supplied to summarizer; other attachments reference-only"
                : "reference-only; visual contents were not inspected by the summarizer") +
            "):\n" +
            refs.map(({ ref, mime }) => `- ${mime}: ${JSON.stringify(ref)}`).join("\n")
        )
    }
}
