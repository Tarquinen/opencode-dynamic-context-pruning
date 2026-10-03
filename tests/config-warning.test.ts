import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../lib/config"

const root = mkdtempSync(join(tmpdir(), "dcp-config-warning-"))
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
process.env.XDG_DATA_HOME = join(root, "data")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { describeEffectiveThresholds, CONFIG_REQUIRES_RESTART_NOTE } =
    await import("../lib/thresholds")

function configWith(overrides: Record<string, unknown>): PluginConfig {
    return {
        compress: {
            minContextLimit: 50000,
            maxContextLimit: 100000,
            ...overrides,
        },
    } as unknown as PluginConfig
}

// A percentage cannot be turned into a token count until the host reports the
// model context window. Reporting only "Unknown keys" left the user unable to
// tell that their thresholds had silently fallen back to a different value.
test("absolute thresholds are reported in tokens", () => {
    const line = describeEffectiveThresholds(configWith({}))
    assert.match(line, /compress\.minContextLimit=50000 tokens/)
    assert.match(line, /compress\.maxContextLimit=100000 tokens/)
})

test("percentage thresholds say what they are relative to", () => {
    const line = describeEffectiveThresholds(
        configWith({ minContextLimit: "35%", maxContextLimit: "60%" }),
    )
    assert.match(line, /compress\.minContextLimit="35%" of the model context window/)
    assert.match(line, /compress\.maxContextLimit="60%" of the model context window/)
})

test("a mixed configuration reports each form separately", () => {
    const line = describeEffectiveThresholds(
        configWith({ minContextLimit: "35%", maxContextLimit: 100000 }),
    )
    assert.match(line, /minContextLimit="35%" of the model context window/)
    assert.match(line, /maxContextLimit=100000 tokens/)
})

test("the description names the keys the schema actually uses", () => {
    // #631's reporter put modelMaxLimits/modelMinLimits at the top level and
    // per-model entries under compress["provider/model"], which is not the
    // schema. The message has to point at the real keys.
    const line = describeEffectiveThresholds(configWith({}))
    assert.doesNotMatch(line, /modelMaxLimits/)
    assert.doesNotMatch(line, /modelMinLimits/)
    assert.match(line, /^Effective thresholds: /)
})

test("the plugin logs the thresholds it is running with", async () => {
    const source = await import("node:fs").then((fs) =>
        fs.readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8"),
    )
    assert.match(source, /thresholds: describeEffectiveThresholds\(config\)/)
    assert.match(source, /restart OpenCode after editing it/)
})

test("the config warning mentions the restart requirement", async () => {
    assert.match(
        CONFIG_REQUIRES_RESTART_NOTE,
        /Config is read once at startup - restart OpenCode after editing it\./,
    )
    const source = await import("node:fs").then((fs) =>
        fs.readFileSync(join(import.meta.dirname, "..", "lib", "config.ts"), "utf8"),
    )
    assert.match(source, /CONFIG_REQUIRES_RESTART_NOTE/)
    // The warning is emitted after the merge, so it can report what is in force.
    const mergeIndex = source.indexOf("config = mergeLayer(config, result.data)")
    const warnIndex = source.indexOf("showConfigWarnings(ctx, diagnostics, config)")
    assert.ok(mergeIndex > 0 && warnIndex > mergeIndex, "warning must be emitted after the merge")
    // Diagnostics are collected per layer rather than warned per layer.
    assert.doesNotMatch(source, /showConfigWarnings\(ctx, layer\.path/)
})

test("thresholds stay importable without the JSONC parser", async () => {
    // config.ts pulls in jsonc-parser, whose published ESM entry has no named
    // `parse` export and only works once tsup bundles it. Keeping the helper in
    // its own module is what makes it testable at all.
    const source = await import("node:fs").then((fs) =>
        fs.readFileSync(join(import.meta.dirname, "..", "lib", "thresholds.ts"), "utf8"),
    )
    assert.doesNotMatch(source, /jsonc-parser/)
    // A type-only import of PluginConfig is erased at runtime and is fine; a
    // value import would drag the parser back in.
    assert.doesNotMatch(source, /^import \{[^}]*\} from "\.\/config"$/m)
})
