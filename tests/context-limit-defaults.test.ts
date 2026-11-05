import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { createSessionState, type WithParts } from "../lib/state"

// `lib/config` cannot be imported from tests (its `jsonc-parser` ESM subpath has no
// named exports under tsx), so the shipped defaults are asserted against the schema
// and the config source instead of against the runtime object.
const repoRoot = join(import.meta.dirname, "..")

function percentageConfig(maxContextLimit: string, minContextLimit: string): PluginConfig {
    return {
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: maxContextLimit as `${number}%`,
            minContextLimit: minContextLimit as `${number}%`,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
    } as PluginConfig
}

function buildMessages(inputTokens: number): WithParts[] {
    const sessionID = "ses_context_limit_defaults"

    return [
        {
            info: {
                id: "msg-user",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
                model: { providerID: "opencode-go", modelID: "big-window" },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-user-part",
                    messageID: "msg-user",
                    sessionID,
                    type: "text" as const,
                    text: "continue please",
                },
            ],
        },
        {
            info: {
                id: "msg-assistant",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: {
                    input: inputTokens,
                    output: 10,
                    reasoning: 0,
                    cache: {
                        read: 0,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-assistant-part",
                    messageID: "msg-assistant",
                    sessionID,
                    type: "text" as const,
                    text: "done",
                },
            ],
        },
    ]
}

function limitsFor(modelContextLimit: number | undefined, tokens: number) {
    const state = createSessionState("ses_context_limit_defaults")
    state.modelContextLimit = modelContextLimit
    return isContextOverLimits(
        percentageConfig("70%", "35%"),
        state,
        "opencode-go",
        "big-window",
        buildMessages(tokens),
    )
}

test("shipped default limits are percentages, not absolute token budgets", () => {
    const schema = JSON.parse(readFileSync(join(repoRoot, "dcp.schema.json"), "utf-8"))
    const compress = schema.properties.compress.properties

    assert.equal(compress.maxContextLimit.default, "70%")
    assert.equal(compress.minContextLimit.default, "35%")
    assert.equal(schema.properties.compress.default.maxContextLimit, "70%")
    assert.equal(schema.properties.compress.default.minContextLimit, "35%")

    const configSource = readFileSync(join(repoRoot, "lib", "config.ts"), "utf-8")
    assert.match(configSource, /maxContextLimit: "70%",/)
    assert.match(configSource, /minContextLimit: "35%",/)
})

test("percentage defaults stay quiet well past 100k on a 1M window", () => {
    const at250k = limitsFor(1_000_000, 250_000)
    assert.equal(at250k.overMaxLimit, false)
    assert.equal(at250k.overMinLimit, false)

    const at750k = limitsFor(1_000_000, 750_000)
    assert.equal(at750k.overMaxLimit, true)
    assert.equal(at750k.overMinLimit, true)
})

test("percentage defaults keep the historical thresholds on a 128k window", () => {
    const at80k = limitsFor(128_000, 80_000)
    assert.equal(at80k.overMaxLimit, false)
    assert.equal(at80k.overMinLimit, true)

    const at95k = limitsFor(128_000, 95_000)
    assert.equal(at95k.overMaxLimit, true)
})

test("percentage defaults fail open when the model window is unknown", () => {
    const unknown = limitsFor(undefined, 500_000)
    assert.equal(unknown.overMaxLimit, false)
})
