import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { existsSync } from "fs"
import { homedir } from "os"

export class Logger {
    private logDir: string
    public enabled: boolean

    constructor(enabled: boolean) {
        this.enabled = enabled
        const opencodeConfigDir = join(homedir(), ".config", "opencode")
        this.logDir = join(opencodeConfigDir, "logs", "dcp")
    }

    private async ensureLogDir() {
        if (!existsSync(this.logDir)) {
            await mkdir(this.logDir, { recursive: true })
        }
    }

    private formatData(data?: any): string {
        if (!data) return ""

        const parts: string[] = []
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined || value === null) continue

            // Format arrays compactly
            if (Array.isArray(value)) {
                if (value.length === 0) continue
                parts.push(
                    `${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`,
                )
            } else if (typeof value === "object") {
                const str = JSON.stringify(value)
                if (str.length < 50) {
                    parts.push(`${key}=${str}`)
                }
            } else {
                parts.push(`${key}=${value}`)
            }
        }
        return parts.join(" ")
    }

    private getCallerFile(skipFrames: number = 3): string {
        const originalPrepareStackTrace = Error.prepareStackTrace
        try {
            const err = new Error()
            Error.prepareStackTrace = (_, stack) => stack
            const stack = err.stack as unknown as NodeJS.CallSite[]
            Error.prepareStackTrace = originalPrepareStackTrace

            // Skip specified number of frames to get to actual caller
            for (let i = skipFrames; i < stack.length; i++) {
                const filename = stack[i]?.getFileName()
                if (filename && !filename.includes("/logger.")) {
                    // Extract just the filename without path and extension
                    const match = filename.match(/([^/\\]+)\.[tj]s$/)
                    return match ? match[1] : filename
                }
            }
            return "unknown"
        } catch {
            return "unknown"
        }
    }

    private async write(level: string, component: string, message: string, data?: any) {
        if (!this.enabled) return

        try {
            await this.ensureLogDir()

            const timestamp = new Date().toISOString()
            const dataStr = this.formatData(data)

            const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? " | " + dataStr : ""}\n`

            const dailyLogDir = join(this.logDir, "daily")
            if (!existsSync(dailyLogDir)) {
                await mkdir(dailyLogDir, { recursive: true })
            }

            const logFile = join(dailyLogDir, `${new Date().toISOString().split("T")[0]}.log`)
            await writeFile(logFile, logLine, { flag: "a" })
        } catch (error) {}
    }

    info(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("INFO", component, message, data)
    }

    debug(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("DEBUG", component, message, data)
    }

    warn(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("WARN", component, message, data)
    }

    error(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("ERROR", component, message, data)
    }

    /**
     * Strips unnecessary metadata from messages for cleaner debug logs.
     *
     * Removed:
     * - All IDs (id, sessionID, messageID, parentID, callID on parts)
     * - summary, path, cost, model, agent, mode, finish, providerID, modelID
     * - step-start and step-finish parts entirely
     * - snapshot fields
     * - ignored text parts
     *
     * Kept:
     * - role, time (created only), tokens (input, output, reasoning, cache)
     * - text, reasoning, tool parts with content
     * - tool calls with: tool, callID, input, output
     */
    private minimizeForDebug(messages: any[]): any[] {
        return messages.map((msg) => {
            const minimized: any = {
                role: msg.info?.role,
            }

            if (msg.info?.time?.created) {
                minimized.time = msg.info.time.created
            }

            if (msg.info?.tokens) {
                minimized.tokens = {
                    input: msg.info.tokens.input,
                    output: msg.info.tokens.output,
                    reasoning: msg.info.tokens.reasoning,
                    cache: msg.info.tokens.cache,
                }
            }

            if (msg.parts) {
                minimized.parts = msg.parts
                    .map((part: any) => {
                        if (part.type === "step-start" || part.type === "step-finish") {
                            return null
                        }

                        if (part.type === "text") {
                            if (part.ignored) return null
                            return { type: "text", text: part.text }
                        }

                        if (part.type === "reasoning") {
                            return {
                                type: "reasoning",
                                text: part.text,
                            }
                        }

                        if (part.type === "tool") {
                            const toolPart: any = {
                                type: "tool",
                                tool: part.tool,
                                callID: part.callID,
                            }

                            if (part.state?.status) {
                                toolPart.status = part.state.status
                            }
                            if (part.state?.input) {
                                toolPart.input = part.state.input
                            }
                            if (part.state?.output) {
                                toolPart.output = part.state.output
                            }
                            if (part.state?.error) {
                                toolPart.error = part.state.error
                            }

                            return toolPart
                        }

                        return null
                    })
                    .filter(Boolean)
            }

            return minimized
        })
    }

    async saveContext(sessionId: string, messages: any[]) {
        if (!this.enabled) return

        try {
            const contextDir = join(this.logDir, "context", sessionId)
            if (!existsSync(contextDir)) {
                await mkdir(contextDir, { recursive: true })
            }

            const minimized = this.minimizeForDebug(messages)
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
            const contextFile = join(contextDir, `${timestamp}.json`)
            await writeFile(contextFile, JSON.stringify(minimized, null, 2))
        } catch (error) {}
    }
}
