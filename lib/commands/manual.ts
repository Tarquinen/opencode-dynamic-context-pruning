/**
 * DCP Manual mode command handler.
 * Handles toggling manual mode and triggering individual tool executions.
 *
 * Usage:
 *   /dcp manual [on|off]  - Toggle manual mode or set explicit state
 *   /dcp-compress [focus]  - Trigger manual compress execution
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { sendIgnoredMessage } from "../ui/notification"
import { saveManualModeSetting } from "../state/persistence"
import { getCurrentParams } from "../token-utils"
import { buildCompressedBlockGuidance } from "../prompts/extensions/nudge"
import { isIgnoredUserMessage } from "../messages/query"

const MANUAL_MODE_ON = "Manual mode is now ON. Use /dcp-compress to trigger context tools manually."

const MANUAL_MODE_OFF = "Manual mode is now OFF."

const COMPRESS_TRIGGER_PROMPT = [
    "<compress triggered manually>",
    "Manual mode trigger received. You must now use the compress tool.",
    "Find the most significant completed conversation content that can be compressed into a high-fidelity technical summary.",
    "Follow the active compress mode, preserve all critical implementation details, and choose safe targets.",
    "Return after compress with a brief explanation of what content was compressed.",
].join("\n\n")

function getTriggerPrompt(
    tool: "compress",
    state: SessionState,
    config: PluginConfig,
    userFocus?: string,
    messages?: WithParts[],
): string {
    const base = COMPRESS_TRIGGER_PROMPT
    const compressedBlockGuidance =
        config.compress.mode === "message" ? "" : buildCompressedBlockGuidance(state, messages)

    const sections = [base, compressedBlockGuidance]
    if (userFocus && userFocus.trim().length > 0) {
        sections.push(`Additional user focus:\n${userFocus.trim()}`)
    }

    return sections.join("\n\n")
}

export interface ManualCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export async function handleManualToggleCommand(
    ctx: ManualCommandContext,
    modeArg?: string,
): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    if (modeArg === "on") {
        state.manualMode = "active"
    } else if (modeArg === "off") {
        state.manualMode = false
    } else {
        state.manualMode = state.manualMode ? false : "active"
    }

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(
        client,
        sessionId,
        state.manualMode ? MANUAL_MODE_ON : MANUAL_MODE_OFF,
        params,
        logger,
    )
    await saveManualModeSetting(sessionId, !!state.manualMode, logger)

    logger.info("Manual mode toggled", { manualMode: state.manualMode })
}

export async function handleManualTriggerCommand(
    ctx: ManualCommandContext,
    tool: "compress",
    userFocus?: string,
): Promise<string | null> {
    return getTriggerPrompt(tool, ctx.state, ctx.config, userFocus, ctx.messages)
}

export function applyPendingManualTrigger(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): void {
    const pending = state.pendingManualTrigger
    if (!pending) {
        return
    }

    if (!state.sessionId || pending.sessionId !== state.sessionId) {
        state.pendingManualTrigger = null
        return
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) {
                continue
            }

            part.text = pending.prompt
            state.pendingManualTrigger = null
            logger.debug("Applied manual prompt", { sessionId: pending.sessionId })
            return
        }
    }

    state.pendingManualTrigger = null
}
