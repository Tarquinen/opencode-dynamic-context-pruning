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
import {
  getPendingPrune,
  setPendingPrune,
  setAutoConfirm,
} from "./lib/ui/confirmation";

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
        name: "dcp-confirm",
        template: {
          type: "box",
          direction: "column",
          bg: "backgroundPanel",
          paddingY: 0,
          gap: 0,
          children: [
            {
              type: "box",
              direction: "row",
              gap: 1,
              paddingX: 2,
              paddingY: 1,
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
              type: "box",
              direction: "column",
              paddingX: 2,
              paddingBottom: 1,
              children: [
                {
                  type: "checklist",
                  items: "{{items}}",
                  fg: "textMuted",
                  fgChecked: "text",
                  borderColorChecked: "warning",
                  onToggle: "item-toggled",
                },
              ],
            },
            {
              type: "box",
              direction: "row",
              gap: 0,
              justifyContent: "space-between",
              bg: "backgroundElement",
              paddingY: 1,
              paddingX: 2,
              children: [
                {
                  type: "box",
                  direction: "row",
                  gap: 0,
                  children: [
                    {
                      type: "text",
                      content: "click items to select",
                      fg: "textMuted",
                    },
                  ],
                },
                {
                  type: "button-group",
                  gap: 1,
                  defaultIndex: 2,
                  bgColor: "backgroundElement",
                  children: [
                    {
                      type: "confirm-button",
                      label: "Reject",
                      fg: "textMuted",
                      bg: "backgroundPanel",
                      fgHover: "warning",
                      borderColorHover: "warning",
                      onConfirm: "cancel-prune",
                    },
                    {
                      type: "confirm-button",
                      label: "Auto",
                      fg: "textMuted",
                      bg: "backgroundPanel",
                      fgHover: "warning",
                      borderColorHover: "warning",
                      onConfirm: "auto-prune",
                    },
                    {
                      type: "confirm-button",
                      label: "Confirm",
                      fg: "textMuted",
                      bg: "backgroundPanel",
                      fgHover: "warning",
                      borderColorHover: "warning",
                      onConfirm: "confirm-prune",
                    },
                  ],
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
        } else if (event.event === "auto-prune" && pending) {
          // Enable auto-confirm and confirm this one
          setAutoConfirm(true);
          const confirmed = pending.items
            .filter((i: { checked: boolean }) => i.checked)
            .map((i: { id: string }) => i.id);
          pending.resolve(confirmed);
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
    event: createEventHandler(
      ctx.client,
      config,
      state,
      logger,
      ctx.directory,
      () => setAutoConfirm(false),
    ),
  };
}) satisfies Plugin;

export default plugin;
