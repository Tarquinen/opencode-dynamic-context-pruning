import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import {
    assignMessageRefs,
    formatMessageRef,
    parseMessageRef,
    MESSAGE_REF_MAX_INDEX,
} from "../lib/message-ids"
import { checkSession, createSessionState, type WithParts } from "../lib/state"

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildCompactedMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    "Compaction summary",
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    "Continue after compaction",
                ),
            ],
        },
    ]
}

test("checkSession resets message id aliases after native compaction", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    state.messageIds.byRawId.set("old-message-9998", "m9998")
    state.messageIds.byRawId.set("old-message-9999", "m9999")
    state.messageIds.byRef.set("m9998", "old-message-9998")
    state.messageIds.byRef.set("m9999", "old-message-9999")
    state.messageIds.nextRef = 9999

    await checkSession({} as any, state, logger, messages, false)

    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.size, 0)
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.nextRef, 1)

    const assigned = assignMessageRefs(state, messages)

    assert.equal(assigned, 2)
    assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m0001")
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0002")
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-assistant-summary")
    assert.equal(state.messageIds.byRef.get("m0002"), "msg-user-follow-up")
    assert.equal(state.messageIds.nextRef, 3)
})

function conversation(sessionID: string, count: number): WithParts[] {
    return Array.from({ length: count }, (_, index) => ({
        info: {
            id: `msg_${index + 1}`,
            role: index % 2 === 0 ? "user" : "assistant",
            sessionID,
            agent: "build",
            model: { providerID: "lab", modelID: "test" },
            time: { created: index + 1 },
        },
        parts: [{ type: "text", text: `body ${index}` }],
    })) as WithParts[]
}

test("a conversation longer than 9999 messages still receives aliases", () => {
    const sessionID = `ses_long_${Date.now()}`
    const state = createSessionState()
    const messages = conversation(sessionID, 10028)

    assert.doesNotThrow(() => assignMessageRefs(state, messages))

    assert.equal(state.messageIds.byRawId.size, 10028)
    assert.equal(state.messageIds.byRawId.get("msg_9999"), "m9999")
    assert.equal(state.messageIds.byRawId.get("msg_10000"), "m10000")
    assert.equal(state.messageIds.byRawId.get("msg_10028"), "m10028")
    assert.equal(state.messageIds.byRef.get("m10028"), "msg_10028")
})

test("four digit aliases keep their exact rendering, five digits only appear past 9999", () => {
    // Widening the pool must not rewrite tags that already exist in a live
    // session, because every rewritten mid-conversation tag breaks the
    // provider prompt cache.
    assert.equal(formatMessageRef(1), "m0001")
    assert.equal(formatMessageRef(9999), "m9999")
    assert.equal(formatMessageRef(10000), "m10000")
    assert.equal(formatMessageRef(MESSAGE_REF_MAX_INDEX), "m99999")

    for (const ref of ["m0001", "m9999", "m10000", "m99999"]) {
        assert.equal(parseMessageRef(ref), Number(ref.slice(1)), ref)
    }
    for (const invalid of ["m100000", "m000", "mabc", "1000"]) {
        assert.equal(parseMessageRef(invalid), null, invalid)
    }
})

test("aliases for messages that left the conversation are reclaimed", () => {
    const sessionID = `ses_reclaim_${Date.now()}`
    const state = createSessionState()
    const full = conversation(sessionID, 40)
    assignMessageRefs(state, full)
    assert.equal(state.messageIds.byRawId.size, 40)

    // opencode compaction, /fork and /undo all shorten the message list.
    const shortened = full.slice(20)
    assignMessageRefs(state, shortened)

    assert.equal(state.messageIds.byRawId.size, 20)
    assert.equal(state.messageIds.byRef.size, 20)
    assert.equal(state.messageIds.byRef.get("m0001"), undefined)
    assert.equal(state.messageIds.byRawId.get("msg_1"), undefined)
    assert.equal(state.messageIds.byRef.get("m0021"), "msg_21")
    assert.equal(state.messageIds.byRef.get("m0040"), "msg_40")
})

test("reclaimed aliases are reused instead of exhausting the pool", () => {
    const sessionID = `ses_reuse_${Date.now()}`
    const state = createSessionState()
    const full = conversation(sessionID, 10028)
    assignMessageRefs(state, full)
    assert.equal(state.messageIds.nextRef, 10029)

    // The session keeps living past the point where the pool used to be empty.
    const live = full.slice(10020)
    for (let i = 0; i < 40; i++) {
        const next = [
            ...live,
            ...conversation(sessionID, 1).map((m) => ({
                ...m,
                info: { ...m.info, id: `msg_new_${i}` },
            })),
        ]
        assert.doesNotThrow(() => assignMessageRefs(state, next))
    }
    assert.equal(state.messageIds.byRef.size, state.messageIds.byRawId.size)
})
