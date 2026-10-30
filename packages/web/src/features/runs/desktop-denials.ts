// ADR-0048 amendment 1, A4 (owner, 2026-10-17: deny-not-ask accepted, "但是要记录"): a desktop call
// refused for a network target leaves a `desktop`/`egress_denied` log event with the host, the
// kind, the reason and the tool call. The run story shows each one and counts them, the technical
// log names the host, and the Activity card's opened record counts them. Pure.

import type { RunEvent } from "@deskmates/contracts";

/** Whether a ledger event is a recorded desktop network denial. */
export function isDesktopDenial(event: Pick<RunEvent, "kind" | "payload">): boolean {
  return (
    event.kind === "log" &&
    event.payload.source === "desktop" &&
    event.payload.op === "egress_denied"
  );
}

/** How many denials the events hold, and their distinct hosts in first-seen order. */
export function desktopDenials(events: readonly Pick<RunEvent, "kind" | "payload">[]): {
  count: number;
  hosts: string[];
} {
  const hosts: string[] = [];
  let count = 0;
  for (const event of events) {
    if (!isDesktopDenial(event)) continue;
    count += 1;
    const host = event.payload.host;
    if (typeof host === "string" && host !== "" && !hosts.includes(host)) hosts.push(host);
  }
  return { count, hosts };
}
