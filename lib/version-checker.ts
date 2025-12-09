import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { homedir } from 'os'

export const PACKAGE_NAME = '@tarquinen/opencode-dcp'
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function getLocalVersion(): string {
    try {
        const pkgPath = join(__dirname, '../../package.json')
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        return pkg.version
    } catch {
        return '0.0.0'
    }
}

export async function getNpmVersion(): Promise<string | null> {
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        const res = await fetch(NPM_REGISTRY_URL, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        })
        clearTimeout(timeout)

        if (!res.ok) return null
        const data = await res.json() as { version?: string }
        return data.version ?? null
    } catch {
        return null
    }
}

export function isOutdated(local: string, remote: string): boolean {
    const parseVersion = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0)
    const [localParts, remoteParts] = [parseVersion(local), parseVersion(remote)]

    for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {
        const l = localParts[i] ?? 0
        const r = remoteParts[i] ?? 0
        if (r > l) return true
        if (l > r) return false
    }
    return false
}

export async function performUpdate(targetVersion: string, logger?: { info: (component: string, message: string, data?: any) => void }): Promise<boolean> {
    // OpenCode installs packages to ~/.cache/opencode/node_modules/
    const cacheDir = join(homedir(), '.cache', 'opencode')
    const packageDir = join(cacheDir, 'node_modules', '@tarquinen', 'opencode-dcp')
    const packageSpec = `${PACKAGE_NAME}@${targetVersion}`

    logger?.info("version", "Starting auto-update", { targetVersion, cacheDir })

    try {
        const { rmSync, existsSync } = await import('fs')
        const lockFile = join(cacheDir, 'node_modules', '.package-lock.json')
        if (existsSync(lockFile)) {
            // Remove the lock file to force npm to re-resolve the package
            rmSync(lockFile, { force: true })
            logger?.info("version", "Removed package-lock.json to force fresh resolution")
        }
    } catch (err) {
        logger?.info("version", "Could not remove lock file", { error: (err as Error).message })
    }

    return new Promise((resolve) => {
        let resolved = false

        const proc = spawn('npm', ['install', '--legacy-peer-deps', packageSpec], {
            cwd: cacheDir,
            stdio: 'pipe'
        })

        let stderr = ''
        proc.stderr?.on('data', (data) => {
            stderr += data.toString()
        })

        proc.on('close', (code) => {
            if (resolved) return
            resolved = true
            clearTimeout(timeoutId)
            if (code === 0) {
                logger?.info("version", "Auto-update succeeded", { targetVersion })
                resolve(true)
            } else {
                logger?.info("version", "Auto-update failed", { targetVersion, code, stderr: stderr.slice(0, 500) })
                resolve(false)
            }
        })

        proc.on('error', (err) => {
            if (resolved) return
            resolved = true
            clearTimeout(timeoutId)
            logger?.info("version", "Auto-update error", { targetVersion, error: err.message })
            resolve(false)
        })

        // Timeout after 60 seconds
        const timeoutId = setTimeout(() => {
            if (resolved) return
            resolved = true
            proc.kill()
            logger?.info("version", "Auto-update timed out", { targetVersion })
            resolve(false)
        }, 60000)
    })
}

export async function checkForUpdates(
    client: any,
    logger?: { info: (component: string, message: string, data?: any) => void },
    options: { showToast?: boolean; autoUpdate?: boolean } = {}
): Promise<void> {
    const { showToast = true, autoUpdate = false } = options

    try {
        const local = getLocalVersion()
        const npm = await getNpmVersion()

        if (!npm) {
            logger?.info("version", "Version check skipped", { reason: "npm fetch failed" })
            return
        }

        if (!isOutdated(local, npm)) {
            logger?.info("version", "Up to date", { local, npm })
            return
        }

        logger?.info("version", "Update available", { local, npm, autoUpdate })

        if (autoUpdate) {
            // Attempt auto-update
            const success = await performUpdate(npm, logger)

            if (success && showToast) {
                await client.tui.showToast({
                    body: {
                        title: "DCP: Updated!",
                        message: `v${local} → v${npm}\nRestart OpenCode to apply`,
                        variant: "success",
                        duration: 6000
                    }
                })
            } else if (!success && showToast) {
                await client.tui.showToast({
                    body: {
                        title: "DCP: Update failed",
                        message: `v${local} → v${npm}\nManual: npm install ${PACKAGE_NAME}@${npm}`,
                        variant: "warning",
                        duration: 6000
                    }
                })
            }
        } else if (showToast) {
            await client.tui.showToast({
                body: {
                    title: "DCP: Update available",
                    message: `v${local} → v${npm}`,
                    variant: "info",
                    duration: 6000
                }
            })
        }
    } catch {
    }
}
