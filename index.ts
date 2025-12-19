import type { Plugin } from "@opencode-ai/plugin";
import { getConfig } from "./lib/config";
import { Logger } from "./lib/logger";
import { loadPrompt } from "./lib/prompt";
import { createSessionState } from "./lib/state";
import { createPruneTool } from "./lib/strategies";
import {
  createChatMessageTransformHandler,
  createEventHandler,
} from "./lib/hooks";
import { getPendingPrune, setPendingPrune } from "./lib/ui/confirmation";

const plugin: Plugin = (async (ctx) => {
  const config = getConfig(ctx);

  if (!config.enabled) {
    return {};
  }

  // Suppress AI SDK warnings
  if (typeof globalThis !== "undefined") {
    (globalThis as any).AI_SDK_LOG_WARNINGS = false;
  }

  // Initialize core components
  const logger = new Logger(config.debug);
  const state = createSessionState();

  // Log initialization
  logger.info("DCP initialized", {
    strategies: config.strategies,
  });

  return {
    ui: [
      {
        name: "dcp-status",
        template: {
          type: "box",
          direction: "row",
          border: ["right"],
          borderStyle: "heavy",
          borderColor: "accent",
          bg: "#1a1a2e",
          paddingX: 1,
          paddingY: 0,
          gap: 1,
          children: [
            { type: "text", content: "📦 DCP", fg: "accent", bold: true },
            { type: "text", content: " │ ", fg: "textMuted" },
            { type: "text", content: "{{saved}}", fg: "accent", bold: true },
            { type: "text", content: " saved", fg: "textMuted" },
          ],
        },
      },
      {
        name: "dcp-confirm",
        template: {
          type: "box",
          direction: "column",
          border: ["left"],
          borderStyle: "heavy",
          borderColor: "accent",
          bg: "backgroundPanel",
          paddingX: 2,
          paddingY: 0,
          minWidth: 60,
          alignSelf: "center",
          gap: 1,
          children: [
            {
              type: "box",
              direction: "row",
              gap: 1,
              children: [
                {
                  type: "text",
                  content: "Select files to prune",
                  fg: "text",
                  bold: true,
                },
              ],
            },
            {
              type: "checklist",
              items: "{{items}}",
              fg: "textMuted",
              fgChecked: "text",
              bgChecked: "backgroundElement",
              borderColorChecked: "accent",
              onToggle: "item-toggled",
            },
            {
              type: "box",
              direction: "row",
              gap: 2,
              justifyContent: "flex-end",
              children: [
                {
                  type: "confirm-button",
                  label: " Cancel ",
                  fg: "textMuted",
                  bg: "backgroundPanel",
                  onConfirm: "cancel-prune",
                },
                {
                  type: "confirm-button",
                  label: " Confirm ",
                  fg: "background",
                  bg: "accent",
                  onConfirm: "confirm-prune",
                },
              ],
            },
          ],
        },
      },
    ],
    "ui.event": async (event: {
      component: string;
      event: string;
      data: Record<string, any>;
    }) => {
      logger.info("UI Event received", event);

      if (event.component === "dcp-confirm") {
        const pending = getPendingPrune();
        if (event.event === "item-toggled" && event.data.items && pending) {
          // Update the pending items state
          pending.items = event.data.items;
        } else if (event.event === "confirm-prune" && pending) {
          const confirmed = pending.items
            .filter((i: { checked: boolean }) => i.checked)
            .map((i: { id: string }) => i.id);
          pending.resolve(confirmed);
          setPendingPrune(null);
        } else if (event.event === "cancel-prune" && pending) {
          pending.resolve([]);
          setPendingPrune(null);
        }
      }
    },
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      const syntheticPrompt = loadPrompt("prune-system-prompt");
      output.system.push(syntheticPrompt);
    },
    "experimental.chat.messages.transform": createChatMessageTransformHandler(
      ctx.client,
      state,
      logger,
      config,
    ),
    tool: config.strategies.pruneTool.enabled
      ? {
          prune: createPruneTool({
            client: ctx.client,
            state,
            logger,
            config,
            workingDirectory: ctx.directory,
          }),
        }
      : undefined,
    config: async (opencodeConfig) => {
      // Add prune to primary_tools by mutating the opencode config
      // This works because config is cached and passed by reference
      if (config.strategies.pruneTool.enabled) {
        const existingPrimaryTools =
          opencodeConfig.experimental?.primary_tools ?? [];
        opencodeConfig.experimental = {
          ...opencodeConfig.experimental,
          primary_tools: [...existingPrimaryTools, "prune"],
        };
        logger.info(
          "Added 'prune' to experimental.primary_tools via config mutation",
        );
      }
    },
    event: createEventHandler(ctx.client, config, state, logger, ctx.directory),
  };
}) satisfies Plugin;

export default plugin;
