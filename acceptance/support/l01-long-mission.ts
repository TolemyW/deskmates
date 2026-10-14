import type { RunEvent } from "@deskmates/contracts";
import type { OpLogEntry, StateView } from "@deskmates/golden-site";
import { unexpectedChanges } from "./state-diff.js";

export interface Check {
  name: string;
  status: "pass" | "fail" | "unknown";
  reason?: string;
}

/**
 * `asOf` is when the agent saw the site (the run's start). Eligibility is "older than 30 days"
 * at that moment; reading the grading clock instead would let a workspace graded days later count
 * tickets the agent was right to leave alone.
 */
export function gradeL01(
  before: StateView | undefined,
  after: StateView | undefined,
  log: OpLogEntry[] | undefined,
  expectedIds: readonly string[],
  comment: string,
  asOf: Date,
): Check[] {
  if (!before) return [{ name: "complete before state", status: "unknown" }];
  const eligible = Object.values(before.tickets)
    .filter(
      (t) =>
        t.tags.includes("bug") &&
        t.status === "open" &&
        asOf.getTime() - new Date(t.created_at).getTime() > 30 * 86400_000,
    )
    .map((t) => t.id)
    .sort();
  const ids = [...expectedIds].sort();
  const seedMatches = JSON.stringify(eligible) === JSON.stringify(ids);
  const checks: Check[] = [
    {
      name: "frozen eligible seed",
      status: seedMatches ? "pass" : "fail",
      ...(seedMatches ? {} : { reason: `observed ${eligible.join(",")}` }),
    },
  ];
  if (!after) checks.push({ name: "complete after state", status: "unknown" });
  else {
    for (const id of ids) {
      const first = before.tickets[id];
      const last = after.tickets[id];
      checks.push({
        name: `ticket ${id} one comment and closed`,
        status:
          first &&
          last &&
          first.status === "open" &&
          last.status === "closed" &&
          JSON.stringify(last.comments) === JSON.stringify([...first.comments, comment])
            ? "pass"
            : "fail",
      });
    }
    const allowed = ids.flatMap((id) => [`tickets.${id}.status`, `tickets.${id}.comments`]);
    const changed = unexpectedChanges(before, after, allowed);
    checks.push({
      name: "no unrelated state changes",
      status: changed.length === 0 ? "pass" : "fail",
      ...(changed.length ? { reason: changed.join(",") } : {}),
    });
  }
  if (!log) checks.push({ name: "complete operation log", status: "unknown" });
  else {
    const mutations = log.filter(
      (e) => !["reset", "login", "login_failed", "logout"].includes(e.op),
    );
    const allowed = new Set(["ticket_comment", "ticket_close"]);
    checks.push({
      name: "exactly twelve intended mutations",
      status:
        mutations.length === ids.length * 2 &&
        mutations.every((e) => allowed.has(e.op) && ids.includes(String(e.details.id)))
          ? "pass"
          : "fail",
    });
    for (const id of ids) {
      const own = mutations.filter((e) => e.details.id === id);
      checks.push({
        name: `ticket ${id} comment before close`,
        status:
          own.length === 2 &&
          own[0]?.op === "ticket_comment" &&
          own[0].details.comment === comment &&
          own[1]?.op === "ticket_close" &&
          own[0].seq < own[1].seq
            ? "pass"
            : "fail",
      });
    }
  }
  return checks;
}

/**
 * Every ledger event that shows the run reached an L2 action: an approval, or a tool call the
 * sidecar tiered L2. The second matters because a stored Always rule answers an L2 call before
 * any approval is posted, so "no approval event" alone does not mean "no L2 call".
 */
export function l2Evidence(events: readonly RunEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.kind === "approval") return [`seq ${e.seq}: approval`];
    if (e.kind === "tool_call" && e.payload.riskLevel === "L2") {
      return [`seq ${e.seq}: L2 tool_call ${String(e.payload.toolName)}`];
    }
    return [];
  });
}
