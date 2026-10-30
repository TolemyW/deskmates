// Oracles of the prepared desktop visual task (ADR-0048 decision 13, `visual-save-task.json`).
// Pure functions over what a harness observed outside the model: the saved file's bytes, the
// fixture window's state read over AT-SPI, and the run's ledger and usage. Nothing here talks to
// a model or a container; the harness that collects the observation is not built yet.

import { createHash } from "node:crypto";

export interface DesktopTaskObservation {
  /** The drawn code for this run. */
  code: string;
  /** Bytes of the saved file, or undefined when it does not exist. */
  savedFile?: Uint8Array;
  /** The fixture window, as the harness read it outside the run. */
  window?: { title: string; status: string };
  /** The run's ledger events, in order. */
  events: { kind: string; payload: Record<string, unknown> }[];
  /** Per-model usage of the run as the Gateway priced it. */
  usage: { model: string; inputTokens?: number; outputTokens?: number; costUsd?: number | null }[];
}

export interface OracleVerdict {
  /** The task outcome, from the independent oracles. */
  success: boolean;
  /** False when a validity condition failed: the run is excluded and reported. */
  valid: boolean;
  failed: string[];
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function fileBytesOracle(o: DesktopTaskObservation): boolean {
  if (!o.savedFile) return false;
  return sha256(o.savedFile) === sha256(new TextEncoder().encode(`${o.code}\n`));
}

export function savedStateOracle(o: DesktopTaskObservation): boolean {
  if (!o.window) return false;
  return !/^\*|\*$|\(modified\)/i.test(o.window.title.trim()) && o.window.status === "Saved";
}

/** A screenshot was taken through the desktop tools before the first input, and no LCU shell. */
export function usedScreenshotOracle(o: DesktopTaskObservation): boolean {
  let captured = false;
  for (const e of o.events) {
    if (e.kind === "log" && e.payload.op === "shell_refused") return false;
    if (e.kind !== "tool_call" || e.payload.toolName !== "mcp__desktop__js") continue;
    const labels = Array.isArray(e.payload.desktopEffects) ? e.payload.desktopEffects : [];
    if (labels.includes("capture")) captured = true;
    if (labels.some((l) => typeof l === "string" && l.startsWith("input")) && !captured)
      return false;
  }
  return captured;
}

/** Full token accounting at a known zero price (ruling 8): never `pricing_missing`. */
export function accountingOracle(o: DesktopTaskObservation): boolean {
  if (o.usage.length === 0) return false;
  if (o.events.some((e) => e.kind === "pricing_missing")) return false;
  return o.usage.every(
    (u) =>
      typeof u.inputTokens === "number" && typeof u.outputTokens === "number" && u.costUsd === 0,
  );
}

export function judgeDesktopTask(o: DesktopTaskObservation): OracleVerdict {
  const failed: string[] = [];
  if (!fileBytesOracle(o)) failed.push("file-bytes");
  if (!savedStateOracle(o)) failed.push("saved-state");
  const validity: string[] = [];
  if (!usedScreenshotOracle(o)) validity.push("used-screenshot");
  if (!accountingOracle(o)) validity.push("accounting");
  return {
    success: failed.length === 0,
    valid: validity.length === 0,
    failed: [...failed, ...validity],
  };
}
