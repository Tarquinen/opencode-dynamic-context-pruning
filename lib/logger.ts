// lib/logger.ts
import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { existsSync } from "fs"
import { homedir } from "os"

export class Logger {
    private logDir: string
    public enabled: boolean
    private fileCounter: number = 0 // Counter to prevent filename collisions

    constructor(enabled: boolean) {
        this.enabled = enabled
        // Always save logs to ~/.config/opencode/logs/dcp/ regardless of installation method
        // This ensures users can find logs in a consistent location
        const opencodeConfigDir = join(homedir(), ".config", "opencode")
        this.logDir = join(opencodeConfigDir, "logs", "dcp")
    }

    private async ensureLogDir() {
        if (!existsSync(this.logDir)) {
            await mkdir(this.logDir, { recursive: true })
        }
    }

    /**
     * Formats data object into a compact, readable string
     * e.g., {saved: "~4.1K", pruned: 4, duplicates: 0} -> "saved=~4.1K pruned=4 duplicates=0"
     */
    private formatData(data?: any): string {
        if (!data) return ""
        
        const parts: string[] = []
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined || value === null) continue
            
            // Format arrays compactly
            if (Array.isArray(value)) {
                if (value.length === 0) continue
                parts.push(`${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`)
            }
            // Format objects inline if small, skip if large
            else if (typeof value === 'object') {
                const str = JSON.stringify(value)
                if (str.length < 50) {
                    parts.push(`${key}=${str}`)
                }
            }
            // Format primitives directly
            else {
                parts.push(`${key}=${value}`)
            }
        }
        return parts.join(" ")
    }

    private async write(level: string, component: string, message: string, data?: any) {
        if (!this.enabled) return

        try {
            await this.ensureLogDir()

            const timestamp = new Date().toISOString()
            const dataStr = this.formatData(data)
            
            // Simple, readable format: TIMESTAMP LEVEL component: message | key=value key=value
            const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? " | " + dataStr : ""}\n`

            const dailyLogDir = join(this.logDir, "daily")
            if (!existsSync(dailyLogDir)) {
                await mkdir(dailyLogDir, { recursive: true })
            }

            const logFile = join(dailyLogDir, `${new Date().toISOString().split('T')[0]}.log`)
            await writeFile(logFile, logLine, { flag: "a" })
        } catch (error) {
            // Silently fail - don't break the plugin if logging fails
        }
    }

    info(component: string, message: string, data?: any) {
        return this.write("INFO", component, message, data)
    }

    debug(component: string, message: string, data?: any) {
        return this.write("DEBUG", component, message, data)
    }

    warn(component: string, message: string, data?: any) {
        return this.write("WARN", component, message, data)
    }

    error(component: string, message: string, data?: any) {
        return this.write("ERROR", component, message, data)
    }

    /**
     * Parses janitor prompt to extract structured components
     * Returns null if parsing fails (not a janitor prompt or malformed)
     * 
     * Note: The session history in the prompt has literal newlines (not \n escapes)
     * due to prompt.ts line 93 doing .replace(/\\n/g, '\n') for readability.
     * We need to reverse this before parsing.
     */
    private parseJanitorPrompt(prompt: string): {
        instructions: string
        availableToolCallIds: string[]
        sessionHistory: any[]
        responseSchema: any
    } | null {
        try {
            // Extract available tool call IDs
            const idsMatch = prompt.match(/Available tool call IDs for analysis:\s*([^\n]+)/)
            const availableToolCallIds = idsMatch 
                ? idsMatch[1].split(',').map(id => id.trim())
                : []

            // Extract session history (between "Session history" and "\n\nYou MUST respond")
            // The captured text has literal newlines, so we need to escape them back to \n for valid JSON
            const historyMatch = prompt.match(/Session history[^\n]*:\s*\n([\s\S]*?)\n\nYou MUST respond/)
            let sessionHistory: any[] = []
            
            if (historyMatch) {
                // Re-escape newlines in string literals for valid JSON parsing
                // This reverses the .replace(/\\n/g, '\n') done in prompt.ts
                const historyText = historyMatch[1]
                
                // Fix: escape literal newlines within strings to make valid JSON
                // We need to be careful to only escape newlines inside string values
                const fixedJson = this.escapeNewlinesInJson(historyText)
                sessionHistory = JSON.parse(fixedJson)
            }

            // Extract instructions (everything before "IMPORTANT: Available tool call IDs")
            const instructionsMatch = prompt.match(/([\s\S]*?)\n\nIMPORTANT: Available tool call IDs/)
            const instructions = instructionsMatch 
                ? instructionsMatch[1].trim()
                : ''

            // Extract response schema (after "You MUST respond with valid JSON matching this exact schema:")
            // Note: The schema contains "..." placeholders which aren't valid JSON, so we save it as a string
            // Now matches until end of prompt since we removed the "Return ONLY..." line
            const schemaMatch = prompt.match(/matching this exact schema:\s*\n(\{[\s\S]*?\})\s*$/)
            const responseSchema = schemaMatch 
                ? schemaMatch[1] // Keep as string since it has "..." placeholders
                : null

            return {
                instructions,
                availableToolCallIds,
                sessionHistory,
                responseSchema
            }
        } catch (error) {
            // If parsing fails, return null and fall back to default logging
            return null
        }
    }

    /**
     * Helper to escape literal newlines within JSON string values
     * This makes JSON with literal newlines parseable again
     */
    private escapeNewlinesInJson(jsonText: string): string {
        // Strategy: Replace literal newlines that appear inside strings with \\n
        // We detect being "inside a string" by tracking quotes
        let result = ''
        let inString = false
        
        for (let i = 0; i < jsonText.length; i++) {
            const char = jsonText[i]
            const prevChar = i > 0 ? jsonText[i - 1] : ''
            
            if (char === '"' && prevChar !== '\\') {
                inString = !inString
                result += char
            } else if (char === '\n' && inString) {
                // Replace literal newline with escaped version
                result += '\\n'
            } else {
                result += char
            }
        }
        
        return result
    }

    /**
     * Saves AI context to a dedicated directory for debugging
     * Each call creates a new timestamped file in ~/.config/opencode/logs/dcp/ai-context/
     * Only writes if debug is enabled
     * 
     * For janitor-shadow sessions, parses and structures the embedded session history
     * for better readability
     */
    async saveWrappedContext(sessionID: string, messages: any[], metadata: any) {
        if (!this.enabled) return

        try {
            await this.ensureLogDir()
            
            const aiContextDir = join(this.logDir, "ai-context")
            if (!existsSync(aiContextDir)) {
                await mkdir(aiContextDir, { recursive: true })
            }

            const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-')
            // Add counter to prevent filename collisions when multiple requests happen in same millisecond
            const counter = (this.fileCounter++).toString().padStart(3, '0')
            const filename = `${timestamp}_${counter}_${sessionID.substring(0, 15)}.json`
            const filepath = join(aiContextDir, filename)

            // Check if this is a janitor-shadow session
            const isJanitorShadow = sessionID === "janitor-shadow" && 
                messages.length === 1 && 
                messages[0]?.role === 'user' &&
                typeof messages[0]?.content === 'string'

            let content: any

            if (isJanitorShadow) {
                // Parse the janitor prompt to extract structured data
                const parsed = this.parseJanitorPrompt(messages[0].content)
                
                if (parsed) {
                    // Create enhanced structured format for readability
                    content = {
                        timestamp: new Date().toISOString(),
                        sessionID,
                        metadata,
                        janitorAnalysis: {
                            instructions: parsed.instructions,
                            availableToolCallIds: parsed.availableToolCallIds,
                            protectedTools: ["task", "todowrite", "todoread"], // From prompt
                            sessionHistory: parsed.sessionHistory,
                            responseSchema: parsed.responseSchema
                        },
                        // Keep raw prompt for reference/debugging
                        rawPrompt: messages[0].content
                    }
                } else {
                    // Parsing failed, use default format
                    content = {
                        timestamp: new Date().toISOString(),
                        sessionID,
                        metadata,
                        messages,
                        note: "Failed to parse janitor prompt structure"
                    }
                }
            } else {
                // Standard format for non-janitor sessions
                content = {
                    timestamp: new Date().toISOString(),
                    sessionID,
                    metadata,
                    messages
                }
            }

            // Pretty print with 2-space indentation
            const jsonString = JSON.stringify(content, null, 2)
            
            await writeFile(filepath, jsonString)
        } catch (error) {
            // Silently fail - don't break the plugin if logging fails
        }
    }
}
