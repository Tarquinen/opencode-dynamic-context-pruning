import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url))

export function loadPrompt(name: string, vars?: Record<string, string>): string {
    const filePath = join(PROMPTS_DIR, `${name}.txt`)
    let content = readFileSync(filePath, "utf8").trim()
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
        }
    }
    return content
}
