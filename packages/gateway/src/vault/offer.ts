// When a run is offered the vault tools (ADR-0045 decision 1): a run of a bot, not a Gateway job
// (a review, a summary, a probe), in a workspace whose Vault holds at least one usable entry on a
// Gateway that can decrypt. Checked at every start, so a resumed run sees the Vault as it is now.

import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { vaultStore } from "./store.js";

export function vaultToolsOffered(
  ctx: Pick<GatewayContext, "db" | "secrets">,
  run: Pick<RunRecord, "config">,
  workspaceId: string,
): boolean {
  if (run.config.runType !== undefined) return false;
  return vaultStore(ctx).hasUsable(workspaceId);
}
