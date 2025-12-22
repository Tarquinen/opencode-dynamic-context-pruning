import type { Logger } from "../logger";
import type { SessionState } from "../state";
import { formatPrunedItemsList } from "./utils";
import { ToolParameterEntry } from "../state";
import { PluginConfig } from "../config";

export type PruneReason = "completion" | "noise" | "consolidation";

export async function sendUnifiedNotification(
  client: any,
  logger: Logger,
  config: PluginConfig,
  state: SessionState,
  sessionId: string,
  pruneToolIds: string[],
  toolMetadata: Map<string, ToolParameterEntry>,
  reason: PruneReason | undefined,
  params: any,
  workingDirectory: string,
): Promise<boolean> {
  const hasPruned = pruneToolIds.length > 0;
  if (!hasPruned) {
    return false;
  }

  if (config.pruningSummary === "off") {
    return false;
  }

  const totalSaved =
    state.stats.totalPruneTokens + state.stats.pruneTokenCounter;
  const itemLines = formatPrunedItemsList(
    pruneToolIds,
    toolMetadata,
    workingDirectory,
  );

  await sendPruneSummary(
    client,
    sessionId,
    params,
    logger,
    totalSaved,
    pruneToolIds.length,
    itemLines,
  );
  return true;
}

export async function sendPruneSummary(
  client: any,
  sessionId: string,
  params: any,
  logger: Logger,
  totalSaved: number,
  count: number,
  itemLines: string[],
): Promise<void> {
  const agent = params.agent || undefined;
  const model =
    params.providerId && params.modelId
      ? {
          providerID: params.providerId,
          modelID: params.modelId,
        }
      : undefined;

  const formatted =
    totalSaved >= 1000
      ? `~${(totalSaved / 1000).toFixed(1)}K`
      : `${totalSaved}`;

  const parts: any[] = [
    {
      type: "text",
      text: "dcp-prune-summary",
      plugin: true,
      metadata: {
        saved: formatted,
        count: String(count),
        itemsList: itemLines.join("\n"),
      },
    },
  ];

  try {
    await client.session.prompt({
      path: {
        id: sessionId,
      },
      body: {
        noReply: true,
        agent: agent,
        model: model,
        parts: parts,
      },
    });
  } catch (error: any) {
    logger.error("Failed to send prune summary", { error: error.message });
  }
}
