// The golden site's test interface over HTTP, the way the benchmark runner reads it
// (benchmark §2.3, §5): the state view, the operation log, and reset to the seed.

import type { OpLogEntry, StateView } from "@deskmates/golden-site";
import type { Stack } from "./start-stack.js";

export async function siteState(stack: Stack): Promise<StateView> {
  const res = await fetch(`${stack.siteUrl}/api/state`);
  if (!res.ok) throw new Error(`GET /api/state: ${res.status}`);
  return (await res.json()) as StateView;
}

export async function siteLog(stack: Stack): Promise<OpLogEntry[]> {
  const res = await fetch(`${stack.siteUrl}/api/state/log`);
  if (!res.ok) throw new Error(`GET /api/state/log: ${res.status}`);
  return (await res.json()) as OpLogEntry[];
}

/** Restore the seed and drop every session, so the next task starts logged out. */
export async function siteReset(stack: Stack): Promise<void> {
  const res = await fetch(`${stack.siteUrl}/api/state/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/state/reset: ${res.status}`);
}
