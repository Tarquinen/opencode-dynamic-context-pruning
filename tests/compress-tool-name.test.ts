import assert from "node:assert/strict"
import test from "node:test"
import "./lab/persistence-env"
import { compressToolName, validateConfigTypes, type PluginConfig } from "../lib/config"
import { renderSystemPrompt, withCompressToolName } from "../lib/prompts"
import { PromptStore } from "../lib/prompts/store"
import { Logger } from "../lib/logger"
import { isCompressToolPart, messageHasCompress } from "../lib/messages/query"
import { getTriggerPrompt } from "../lib/commands/manual"
import { createSessionState, type WithParts } from "../lib/state"

/**
 * The sleev gateway injects its own `compress` tool into every completion
 * request, shadowing any host-registered tool named "compress" on the wire.
 * DCP therefore registers its tool as "dcp_compress" by default. These tests
 * pin the naming plumbing: config resolution + validation, session-part
 * matching (legacy + current names), and prompt text qualification.
 */

function buildConfig(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            ...overrides,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

test("compressToolName defaults to dcp_compress and honors overrides", () => {
    assert.equal(compressToolName(buildConfig()), "dcp_compress")
    assert.equal(compressToolName(buildConfig({ toolName: "my_compressor" })), "my_compressor")
    // Opting back into the legacy name keeps every consumer on the legacy name.
    assert.equal(compressToolName(buildConfig({ toolName: "compress" })), "compress")
})

test("compress.toolName validation accepts identifiers and rejects junk", () => {
    assert.deepEqual(
        validateConfigTypes({ compress: { toolName: "dcp_compress" } }).filter(
            (error) => error.key === "compress.toolName",
        ),
        [],
    )
    for (const junk of ["1bad", "has space", "", 42, null]) {
        const errors = validateConfigTypes({ compress: { toolName: junk } })
        assert.ok(
            errors.some((error) => error.key === "compress.toolName"),
            `expected compress.toolName error for ${JSON.stringify(junk)}`,
        )
    }
})

test("isCompressToolPart matches legacy and current names only", () => {
    assert.equal(isCompressToolPart({ type: "tool", tool: "compress" }), true)
    assert.equal(isCompressToolPart({ type: "tool", tool: "dcp_compress" }), true)
    assert.equal(isCompressToolPart({ type: "tool", tool: "other" }), false)
    assert.equal(isCompressToolPart({ type: "text", tool: "compress" }), false)
    assert.equal(isCompressToolPart(undefined), false)
    assert.equal(isCompressToolPart(null), false)
})

function compressPart(tool: string, status = "completed") {
    return { type: "tool", tool, state: { status } }
}

test("messageHasCompress recognizes completed compress parts under both names", () => {
    const base = { role: "assistant", sessionID: "ses_x", time: { created: 1 } }
    const message = (parts: unknown[]) =>
        ({
            info: { id: "msg-a", ...base },
            parts,
        }) as WithParts

    assert.equal(message([compressPart("compress")]).parts.length > 0, true)
    assert.equal(messageHasCompress(message([compressPart("compress")])), true)
    assert.equal(messageHasCompress(message([compressPart("dcp_compress")])), true)
    assert.equal(messageHasCompress(message([compressPart("compress", "pending")])), false)
    assert.equal(messageHasCompress(message([compressPart("other")])), false)

    const userMessage = {
        info: { id: "msg-u", role: "user", sessionID: "ses_x", time: { created: 0 } },
        parts: [compressPart("compress")],
    } as unknown as WithParts
    assert.equal(messageHasCompress(userMessage), false)
})

test("withCompressToolName rewrites generic compress-tool mentions", () => {
    assert.equal(
        withCompressToolName("Use the compress tool now.", "dcp_compress"),
        "Use the dcp_compress tool now.",
    )
    // Legacy name needs no rewrite.
    assert.equal(
        withCompressToolName("Use the compress tool now.", "compress"),
        "Use the compress tool now.",
    )
    // Non-tool "compress" words are left alone.
    assert.equal(
        withCompressToolName("compressed ranges stay compressed", "dcp_compress"),
        "compressed ranges stay compressed",
    )
})

test("renderSystemPrompt qualifies the manual-mode extension with the tool name", () => {
    const prompts = new PromptStore(new Logger(false), process.cwd(), false).getRuntimePrompts()
    const rendered = renderSystemPrompt(prompts, undefined, true, false, "dcp_compress")
    assert.ok(rendered.includes("dcp_compress tool"), "expected renamed tool mention")
    const legacy = renderSystemPrompt(prompts, undefined, true, false, "compress")
    assert.ok(legacy.includes("compress tool"), "legacy rendering keeps original text")
})

test("manual trigger prompt references the configured tool name", () => {
    const state = createSessionState()
    const renamed = getTriggerPrompt("compress", state, buildConfig())
    assert.ok(renamed.includes("use the dcp_compress tool"))
    assert.ok(renamed.includes("Return after dcp_compress"))
    // The manual-mode marker consumed by the pipeline guard must stay verbatim.
    assert.ok(renamed.includes("<compress triggered manually>"))
    const legacy = getTriggerPrompt(
        "compress",
        state,
        buildConfig({ toolName: "compress" }),
    )
    assert.ok(legacy.includes("use the compress tool"))
})
