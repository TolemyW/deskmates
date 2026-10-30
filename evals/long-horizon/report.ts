import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpLogEntry, StateView } from "@deskmates/golden-site";
import { findSecretsIn } from "../replay/trace.js";
import type { CheckResult } from "./grade.js";
import type { RunObservation, totals } from "./metrics.js";
import type { Verdict } from "./mission.js";

export interface PhaseReport {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: Verdict | "not_reached" | "running";
  runId?: string;
  checks: CheckResult[];
  error?: string;
}
export interface MissionReport {
  schemaVersion: 2;
  workspaceId: string;
  missionId: string;
  specSha256: string;
  repeat: number;
  arm: string;
  startedAt: string;
  finishedAt: string | null;
  /** Immutable image id and model configuration; no endpoint or credential. */
  config: {
    workspaceImageId: string;
    egressProxyImageId: string;
    defaultModel: string;
    cheapModel: string;
  };
  outcome: Verdict;
  termination: string;
  phases: PhaseReport[];
  final: CheckResult[];
  runs: RunObservation[];
  totals: ReturnType<typeof totals>;
  /** Kept separately from oracle outcomes; an observer failure cannot become a model failure. */
  observerErrors: { phase: string; source: string; error: string }[];
  injections: {
    phase: string;
    kind: "gateway_restart";
    startedAt: string;
    finishedAt: string | null;
    ok: boolean;
  }[];
  resources: { at: string; memBytes: number | null; cpuPct: number | null; error?: string }[];
  site: {
    seed?: StateView | undefined;
    after?: StateView | undefined;
    log?: OpLogEntry[] | undefined;
  };
  progressCurve: { atMs: number; op: string; id: unknown }[];
}

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Persist before the first effect; a killed process leaves a reserved, unknown attempt. */
export function reserveReport(dir: string, key: string, pin: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pinPath = join(dir, "long-horizon.meta");
  try {
    writeFileSync(pinPath, `${JSON.stringify(pin)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(pinPath, "utf8") !== `${JSON.stringify(pin)}\n`)
      throw new Error("report directory pins a different mission, image or model configuration");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("invalid report key");
  const file = join(dir, `${key}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ state: "reserved", outcome: "unknown", reservedAt: new Date().toISOString() })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return file;
}

/** Reports stay private; this guard refuses secret-shaped values before any bytes are written. */
export function saveReport(file: string, report: MissionReport, secrets: readonly string[]): void {
  // The golden site's public seed deliberately includes a fake apiToken. Preserve its digest
  // for before/after evidence and scrub just that controlled fixture field in the export copy.
  // Oracles already ran on the untouched server states, so collateral token changes still fail.
  const exported = structuredClone(report);
  const settingsApiTokenDigests: Record<string, string> = {};
  for (const key of ["seed", "after"] as const) {
    const state = exported.site?.[key];
    if (state) {
      settingsApiTokenDigests[key] = digest(state.settings.apiToken);
      state.settings.apiToken = "[redacted]";
    }
  }
  const value = { ...exported, settingsApiTokenDigests };
  const json = JSON.stringify(value, null, 2);
  const findings = findSecretsIn(value);
  if (findings.length)
    throw new Error(
      `report contains secret-shaped data at ${findings.map((f) => f.path).join(", ")}`,
    );
  if (secrets.some((s) => s.length > 4 && json.includes(s)))
    throw new Error("report contains a configured secret");
  const pending = `${file}.pending`;
  writeFileSync(pending, `${json}\n`, { mode: 0o600 });
  renameSync(pending, file);
}
