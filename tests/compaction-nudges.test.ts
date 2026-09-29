import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import type { RuntimePrompts } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"

test("compaction replays existing nudges without changing the cached prefix or adding anchors", () => {
    const state = createSessionState("compact")
    const logger = new Logger(false)
    const config = {
        compress: {
            permission: "allow",
            mode: "range",
            minContextLimit: 0,
            maxContextLimit: 1,
            nudgeFrequency: 1,
            summaryBuffer: false,
        },
    } as PluginConfig
    const prompts = {
        contextLimitNudge: "<dcp-system-reminder>NUDGE_KEEP</dcp-system-reminder>",
        turnNudge: "",
        iterationNudge: "",
    } as RuntimePrompts
    const user = {
        info: {
            id: "msg_user",
            role: "user",
            time: { created: 1 },
            model: { providerID: "lab", modelID: "model" },
        },
        parts: [{ type: "text", text: "Original question" }],
    }
    const raw = [
        user,
        {
            info: {
                id: "msg_answer",
                role: "assistant",
                time: { created: 2 },
                tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Original answer" }],
        },
    ] as WithParts[]
    const primary = structuredClone(raw)
    injectCompressNudges(state, config, logger, primary, prompts)
    assert.match(JSON.stringify(primary), /NUDGE_KEEP/)
    const anchors = structuredClone(state.nudges)
    const compact = structuredClone([
        ...raw,
        { ...user, info: { ...user.info, id: "msg_later" } },
    ]) as WithParts[]
    injectCompressNudges(state, config, logger, compact, prompts, undefined, false)
    assert.deepEqual(compact.slice(0, raw.length), primary)
    assert.deepEqual(state.nudges, anchors)
    assert.doesNotMatch(JSON.stringify(compact.at(-1)), /NUDGE_KEEP/)
})
