import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// MUST be imported before any lib module: persistence.ts computes STORAGE_DIR
// from XDG_DATA_HOME at module-eval time, and ESM evaluates static imports in
// order. Setting the env in the importing test's own module body would be too
// late (hoisted lib imports are evaluated first) and would silently point
// persistence at the real user storage directory.
const testDataHome = join(tmpdir(), `opencode-dcp-persistence-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-persistence-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

export const stateDir = join(testDataHome, "opencode", "storage", "plugin", "dcp")

// Clean the per-pid sandbox when the test process exits.
process.on("exit", () => {
    try {
        rmSync(testDataHome, { recursive: true, force: true })
        rmSync(testConfigHome, { recursive: true, force: true })
    } catch {
        // best effort
    }
})
