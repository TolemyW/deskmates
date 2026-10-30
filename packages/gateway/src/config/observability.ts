// Run observability (ADR-0046 decisions 2 to 4 and 8). `OBSERVABILITY_SINK` unset means the
// collector does not run: the default for an existing installation until a release makes `sqlite`
// the default. `OBSERVABILITY_GRAFANA_URL` is read on its own: it is the Grafana the analytics
// relay forwards to (ADR-0046 amendment 1 decision 11), which needs no sink in this process.

import { resolve } from "node:path";
import {
  DeskmatesError,
  OBSERVABILITY_PAYLOAD_POLICIES,
  type ObservabilityPayloadPolicy,
} from "@deskmates/contracts";
import { type Env, optionalInt, optionalLimit } from "./env.js";

/**
 * The sink ids this release bundles. `postgres` and `forward` are named by ADR-0046 decision 3
 * and ship in phase 2; until then they are refused like any unknown id. `sink-contract.test.ts`
 * checks this list against the loader's table.
 */
export const OBSERVABILITY_SINK_IDS = ["sqlite"] as const;

export type ObservabilitySinkId = (typeof OBSERVABILITY_SINK_IDS)[number];

const PHASE_TWO_SINKS = new Set(["postgres", "forward"]);

export const OBSERVABILITY_DEFAULTS = {
  batchSeconds: 300,
  batchBytes: 64 * 1024 * 1024,
  payloads: "full",
} as const satisfies {
  batchSeconds: number;
  batchBytes: number;
  payloads: ObservabilityPayloadPolicy;
};

export interface ObservabilitySettings {
  sink: ObservabilitySinkId;
  /** `OBSERVABILITY_SQLITE_PATH`; undefined is `obs.sqlite` beside `gateway.sqlite`. */
  sqlitePath?: string;
  batchSeconds: number;
  batchBytes: number;
  payloads: ObservabilityPayloadPolicy;
  /** Days the sink keeps; undefined is unlimited (the default). */
  retentionDays?: number;
  /**
   * `OBSERVABILITY_RETROSPECTIVE`: the failure retrospective runs (ADR-0046 amendment 2 decision
   * 23) unless this is false; it also needs a vector sink and an ADR-0041 embedding service.
   */
  retrospective: boolean;
}

export interface ObservabilityConfig {
  observability?: ObservabilitySettings;
  /**
   * `OBSERVABILITY_GRAFANA_URL`: the loopback origin of the Grafana that `/analytics/*` relays
   * to. The web is told only `/analytics/`, never this address.
   */
  observabilityGrafanaUrl?: string;
}

function sinkId(env: Env): ObservabilitySinkId | undefined {
  const raw = env.OBSERVABILITY_SINK?.trim() ?? "";
  if (raw === "") return undefined;
  if ((OBSERVABILITY_SINK_IDS as readonly string[]).includes(raw))
    return raw as ObservabilitySinkId;
  throw new DeskmatesError(
    "validation",
    PHASE_TWO_SINKS.has(raw)
      ? `OBSERVABILITY_SINK=${raw} is not bundled in this release; use sqlite`
      : `OBSERVABILITY_SINK must be one of: ${OBSERVABILITY_SINK_IDS.join(", ")}`,
    { key: "OBSERVABILITY_SINK", raw },
  );
}

function payloads(env: Env): ObservabilityPayloadPolicy {
  const raw = env.OBSERVABILITY_PAYLOADS?.trim() || OBSERVABILITY_DEFAULTS.payloads;
  if (!(OBSERVABILITY_PAYLOAD_POLICIES as readonly string[]).includes(raw))
    throw new DeskmatesError("validation", "OBSERVABILITY_PAYLOADS must be full or derived", {
      key: "OBSERVABILITY_PAYLOADS",
      raw,
    });
  return raw as ObservabilityPayloadPolicy;
}

/** On by default (owner ruling of 2026-10-18); `off` is the only way to turn it off. */
function retrospective(env: Env): boolean {
  const raw = env.OBSERVABILITY_RETROSPECTIVE?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new DeskmatesError("validation", "OBSERVABILITY_RETROSPECTIVE must be on or off", {
    key: "OBSERVABILITY_RETROSPECTIVE",
    raw,
  });
}

/** The observability file must never be the ledger (decision 4: "a second SQLite file"). */
function sqlitePath(env: Env): { sqlitePath?: string } {
  const raw = env.OBSERVABILITY_SQLITE_PATH?.trim() ?? "";
  if (raw === "") return {};
  if (raw === ":memory:")
    throw new DeskmatesError("validation", "OBSERVABILITY_SQLITE_PATH must be a file", {
      key: "OBSERVABILITY_SQLITE_PATH",
    });
  const ledger = env.GATEWAY_DB?.trim() || "./data/gateway.sqlite";
  if (resolve(raw) === resolve(ledger))
    throw new DeskmatesError(
      "validation",
      "OBSERVABILITY_SQLITE_PATH must not be the Gateway database",
      { key: "OBSERVABILITY_SQLITE_PATH" },
    );
  return { sqlitePath: raw };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The relay's upstream (amendment 1 decisions 11 and 12): Grafana trusts the identity header from
 * the host loopback only, so the address must be a plain `http` origin there, with no path,
 * query or credentials. A decision 6 value naming the host's network address stops startup
 * instead of carrying the header across a network.
 */
export function grafanaUpstream(raw: string): string {
  const refuse = (why: string) =>
    new DeskmatesError(
      "validation",
      `OBSERVABILITY_GRAFANA_URL ${why}; it is the Grafana the Gateway relays /analytics/ to, e.g. http://127.0.0.1:18700 (ADR-0046 amendment 1)`,
      { key: "OBSERVABILITY_GRAFANA_URL" },
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse("is not a URL");
  }
  if (url.protocol !== "http:") throw refuse("must be http");
  if (url.username || url.password) throw refuse("must not carry credentials");
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw refuse("must name the host loopback");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
    throw refuse("must be an origin without a path");
  return url.origin;
}

export function readObservabilityConfig(env: Env): ObservabilityConfig {
  const grafana = env.OBSERVABILITY_GRAFANA_URL?.trim() ?? "";
  const grafanaUrl = grafana === "" ? {} : { observabilityGrafanaUrl: grafanaUpstream(grafana) };
  const sink = sinkId(env);
  if (sink === undefined) return grafanaUrl;
  const retentionDays = optionalLimit(env, "OBSERVABILITY_RETENTION_DAYS", 0);
  return {
    ...grafanaUrl,
    observability: {
      sink,
      ...sqlitePath(env),
      batchSeconds: optionalInt(
        env,
        "OBSERVABILITY_BATCH_SECONDS",
        OBSERVABILITY_DEFAULTS.batchSeconds,
      ),
      batchBytes: optionalInt(env, "OBSERVABILITY_BATCH_BYTES", OBSERVABILITY_DEFAULTS.batchBytes),
      payloads: payloads(env),
      ...(retentionDays > 0 ? { retentionDays } : {}),
      retrospective: retrospective(env),
    },
  };
}
