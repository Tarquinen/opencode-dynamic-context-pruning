import type {Logger} from "../logger";
import type {ToolParameterEntry} from "../state";
import {extractParameterKey} from "../messages/utils";
import {shortenPath, truncate} from "./utils";

export interface PendingConfirmation {
  resolve: (confirmedIds: string[]) => void;
  items: Array<{id: string; label: string; checked: boolean}>;
}

// Shared state for pending confirmations
let pendingPrune: PendingConfirmation | null = null;

// Auto-confirm mode - when true, automatically confirms all prunes
let autoConfirmEnabled = false;

export function getPendingPrune(): PendingConfirmation | null {
  return pendingPrune;
}

export function setPendingPrune(pending: PendingConfirmation | null): void {
  pendingPrune = pending;
}

export function isAutoConfirmEnabled(): boolean {
  return autoConfirmEnabled;
}

export function setAutoConfirm(enabled: boolean): void {
  autoConfirmEnabled = enabled;
}

export function resolvePendingPrune(confirmedIds: string[]): void {
  if (pendingPrune) {
    pendingPrune.resolve(confirmedIds);
    pendingPrune = null;
  }
}

/**
 * Shows a confirmation UI for pruning and returns a Promise that resolves
 * with the list of confirmed tool IDs (or empty array if cancelled).
 * If auto-confirm is enabled, immediately returns all IDs without showing UI.
 */
export async function requestPruneConfirmation(
  client: any,
  sessionId: string,
  pruneToolIds: string[],
  toolMetadata: Map<string, ToolParameterEntry>,
  params: any,
  logger: Logger,
  workingDirectory: string
): Promise<string[]> {
  // If auto-confirm is enabled, immediately return all IDs
  if (autoConfirmEnabled) {
    logger.info("Auto-confirming prune", {itemCount: pruneToolIds.length});
    return pruneToolIds;
  }

  // Build checklist items from the tool metadata
  const items = pruneToolIds.map((id) => {
    const meta = toolMetadata.get(id);
    let label = id;
    if (meta) {
      const toolName = meta.tool.charAt(0).toUpperCase() + meta.tool.slice(1);
      const paramKey = extractParameterKey(meta.tool, meta.parameters);
      if (paramKey) {
        label = `${toolName} ${truncate(
          shortenPath(paramKey, workingDirectory),
          50
        )}`;
      } else {
        label = `${toolName}`;
      }
    }
    return {id, label, checked: true};
  });

  logger.info("Requesting prune confirmation", {itemCount: items.length});

  // Create the promise that will be resolved by UI events
  return new Promise<string[]>((resolve) => {
    setPendingPrune({resolve, items});

    const agent = params.agent || undefined;
    const model =
      params.providerId && params.modelId
        ? {providerID: params.providerId, modelID: params.modelId}
        : undefined;

    // Send the confirmation UI message
    client.session
      .prompt({
        path: {id: sessionId},
        body: {
          noReply: true,
          agent,
          model,
          parts: [
            {
              type: "text",
              text: "dcp-confirm",
              plugin: true,
              metadata: {items},
            },
          ],
        },
      })
      .catch((error: any) => {
        logger.error("Failed to send confirmation UI", {
          error: error.message,
        });
        resolve([]); // Resolve with empty on error
        setPendingPrune(null);
      });
  });
}
