// Result shaping (ADR-0013 Amendment 1, item 5). Raw runtime answers are large (20 search results
// at up to 9,500 tokens, the unfiltered app list at about 101k) and name runtime-side ids a model
// has no use for. What a run sees is cut down here: a search always names a service and returns at
// most five entries of adopted providers; a connection list holds the workspace's own connections
// under the names bots use; runtime connection names and ids never reach a run.

import {
  type AdoptedIntegrationProvider,
  INTEGRATION_SEARCH_LIMIT_MAX,
  type IntegrationAppsResult,
  type IntegrationConnectionsResult,
  type IntegrationSearchResult,
} from "@deskmates/contracts";
import type { StoredIntegrationConnection } from "./integration-store.js";
import type { RuntimeActionEntry, RuntimeConnectionView } from "./runtime-adapter.js";

/** A requested limit, clamped to 1..5; absent or not a number is the maximum. */
export function searchLimit(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested))
    return INTEGRATION_SEARCH_LIMIT_MAX;
  return Math.max(1, Math.min(INTEGRATION_SEARCH_LIMIT_MAX, Math.floor(requested)));
}

/** Adopted providers, each with the workspace's connection names for it; no runtime call. */
export function shapeApps(
  providers: readonly AdoptedIntegrationProvider[],
  connections: readonly StoredIntegrationConnection[],
): IntegrationAppsResult {
  return {
    apps: providers.map((p) => ({
      service: p.service,
      displayName: p.displayName,
      connections: connections.filter((c) => c.service === p.service).map((c) => c.connectionName),
    })),
  };
}

/**
 * The runtime's list for the workspace token, kept only where it matches one of the workspace's
 * own connections: virtual no-auth entries and anything the Gateway did not record are dropped.
 */
export function shapeConnections(
  listed: readonly RuntimeConnectionView[],
  connections: readonly StoredIntegrationConnection[],
): IntegrationConnectionsResult {
  const byRuntimeId = new Map(connections.map((c) => [c.runtimeConnectionId, c]));
  return {
    connections: listed.flatMap((view) => {
      const own = byRuntimeId.get(view.id);
      if (view.virtual || own === undefined) return [];
      return [
        {
          service: own.service,
          connectionName: own.connectionName,
          authKind: own.authKind,
          ...(view.displayName ? { account: view.displayName } : {}),
        },
      ];
    }),
  };
}

/** Entries of this service and of adopted providers only, at most `limit` of them. */
export function shapeSearch(
  service: string,
  entries: readonly RuntimeActionEntry[],
  adopted: ReadonlySet<string>,
  limit: number,
): IntegrationSearchResult {
  return {
    service,
    actions: entries
      .filter((e) => e.service === service && adopted.has(e.service))
      .slice(0, limit)
      .map((e) => ({
        actionId: e.actionId,
        service: e.service,
        name: e.name,
        description: e.description,
        operationType: e.operationType,
        requiredScopes: e.requiredScopes,
        inputs: e.inputs,
      })),
  };
}

/** The guide with the runtime's connection name replaced by the one bots use. */
export function shapeGuideMarkdown(
  markdown: string,
  connection: StoredIntegrationConnection,
): string {
  return markdown.split(connection.runtimeConnectionName).join(connection.connectionName);
}
