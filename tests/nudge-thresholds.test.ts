import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"

const root = mkdtempSync(join(tmpdir(), "dcp-nudges-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { createSessionState } = await import("../lib/state")
const { isContextOverLimits } = await import("../lib/messages/inject/utils")

function config(overrides: Record<string, unknown> = {}): PluginConfig {
    return {
        compress: {
            mode: "range",
            permission: "allow",
            protectedTools: [],
            protectUserMessages: false,
            nudgeFrequency: 1,
            ...overrides,
        },
        manualMode: { enabled: false, automaticStrategies: true },
        experimental: { allowSubAgents: false },
        turnProtection: { enabled: false, turns: 4 },
        strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
        pruneNotification: "off",
        protectedFilePatterns: [],
    } as unknown as PluginConfig
}

function message(
    sessionID: string,
    id: string,
    role: "user" | "assistant",
    created: number,
    text: string,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created },
            tokens:
                role === "assistant"
                    ? { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
                    : undefined,
        },
        parts: [{ id: `prt_${id}`, messageID: id, sessionID, type: "text", text }],
    } as unknown as WithParts
}

function conversation(sessionID: string): WithParts[] {
    return [
        message(sessionID, "msg_1", "user", 1, "first question"),
        message(sessionID, "msg_2", "assistant", 2, "first answer"),
        message(sessionID, "msg_3", "user", 3, "second question"),
        message(sessionID, "msg_4", "assistant", 4, "second answer"),
    ]
}

// A percentage limit cannot be resolved until the host has reported the model
// context window. While it is unknown the old code fell back to "over the lower
// threshold", which is the opposite of what a configured threshold asks for and
// is what made compression start at 4% of the window (#548).
test("an unresolvable percentage threshold does not enable nudges", () => {
    const sessionID = `ses_thresh_${Date.now()}`
    const state = createSessionState()
    const messages = conversation(sessionID)
    const settings = config({ minContextLimit: "15%", maxContextLimit: "80%" })

    // The model context window has not been reported yet.
    state.modelContextLimit = undefined

    const limits = isContextOverLimits(settings, state, "lab", "test", messages)

    assert.equal(limits.overMinLimit, false, "percentage threshold silently became permissive")
    assert.equal(limits.overMaxLimit, false)
})

test("an unparseable threshold does not enable nudges", () => {
    const sessionID = `ses_thresh_bad_${Date.now()}`
    const state = createSessionState()
    const messages = conversation(sessionID)
    const settings = config({ minContextLimit: "not-a-number", maxContextLimit: "80%" })
    state.modelContextLimit = 1_000_000

    const limits = isContextOverLimits(settings, state, "lab", "test", messages)

    assert.equal(limits.overMinLimit, false)
})

test("a resolved threshold is still honoured in both directions", () => {
    const sessionID = `ses_thresh_ok_${Date.now()}`
    const messages = conversation(sessionID)

    const below = isContextOverLimits(
        config({ minContextLimit: "50%", maxContextLimit: "80%" }),
        stateForThreshold(sessionID, "50%"),
        "lab",
        "test",
        messages,
    )
    assert.equal(below.overMinLimit, false, "threshold fired below the configured value")
    assert.equal(below.overMaxLimit, false)

    const above = isContextOverLimits(
        config({ minContextLimit: 1, maxContextLimit: "80%" }),
        stateForThreshold(sessionID, "50%"),
        "lab",
        "test",
        messages,
    )
    assert.equal(above.overMinLimit, true)
    assert.equal(above.overMaxLimit, false)
})

function stateForThreshold(sessionID: string, _label: string) {
    const state = createSessionState()
    state.sessionId = sessionID
    state.modelContextLimit = 1_000_000
    return state
}
