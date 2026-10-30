// The evaluator reads server state and operation log independently of the bot's claimed answer.
import type { OpLogEntry, StateView } from "@deskmates/golden-site";
import { answerOf } from "../../acceptance/support/runs.js";
import { unexpectedChanges } from "../../acceptance/support/state-diff.js";
import type { Comparison, Mission, Oracle, Verdict } from "./mission.js";

export interface CheckResult {
  name: string;
  status: Verdict;
  observed?: unknown;
}
export interface GradeInput {
  mission: Mission;
  seed?: StateView;
  asOf?: string;
  after?: StateView;
  log?: readonly OpLogEntry[];
  phaseLogStart: number;
  run?: { status: string; attempt: number; reply?: string };
  files: Readonly<Record<string, string | null | undefined>>;
}

const NON_MUTATIONS = new Set(["reset", "login", "login_failed", "logout", "mfa"]);
export function mutations(log: readonly OpLogEntry[]): OpLogEntry[] {
  return log.filter((e) => !NON_MUTATIONS.has(e.op) && !e.op.startsWith("human_check"));
}
function compare(op: Comparison, actual: number, expected: number): boolean {
  return op === "eq" ? actual === expected : op === "gte" ? actual >= expected : actual <= expected;
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function grade(oracle: Oracle, g: GradeInput): CheckResult {
  const result = (status: Verdict, observed?: unknown): CheckResult => ({
    name: oracle.name,
    status,
    ...(observed === undefined ? {} : { observed }),
  });
  const count = (actual: number, observed: unknown = actual): CheckResult => {
    if (!("op" in oracle)) throw new Error("count oracle has no comparison");
    return result(compare(oracle.op, actual, oracle.value) ? "pass" : "fail", observed);
  };
  switch (oracle.type) {
    case "eligible_tickets": {
      if (!g.seed || !g.asOf || !Number.isFinite(Date.parse(g.asOf))) return result("unknown");
      const eligible = Object.values(g.seed.tickets)
        .filter(
          (t) =>
            t.status === "open" &&
            t.tags.includes("bug") &&
            Date.parse(g.asOf ?? "") - Date.parse(t.created_at) > 30 * 86400_000,
        )
        .map((t) => t.id)
        .sort();
      return result(
        JSON.stringify(eligible) === JSON.stringify([...g.mission.expected.tickets].sort())
          ? "pass"
          : "fail",
        eligible,
      );
    }
    case "run_status":
      return g.run
        ? result(oracle.in.includes(g.run.status) ? "pass" : "fail", g.run.status)
        : result("unknown");
    case "run_attempt":
      return g.run ? count(g.run.attempt) : result("unknown");
    case "answer": {
      if (!g.run) return result("unknown");
      const answer = answerOf(g.run.reply);
      return result(answer === oracle.value ? "pass" : "fail", answer ?? "no answer");
    }
    case "file_regex_count": {
      const file = g.files[oracle.path];
      if (file === undefined) return result("unknown", "file observation unavailable");
      if (file === null) return result("fail", "file missing");
      const pattern = oracle.regex.replaceAll(
        "{tickets}",
        `(?:${g.mission.expected.tickets.map(escapeRegex).join("|")})`,
      );
      return count([...file.matchAll(new RegExp(pattern, "gm"))].length);
    }
    case "oplog_mutations": {
      if (!g.log) return result("unknown");
      const entries = mutations(g.log).filter((e) => !oracle.ops || oracle.ops.includes(e.op));
      return count(
        entries.length,
        entries.map((e) => ({ op: e.op, id: e.details.id })),
      );
    }
    case "phase_mutations":
      return g.log ? count(mutations(g.log.slice(g.phaseLogStart)).length) : result("unknown");
    case "tickets_swept": {
      if (!g.seed || !g.after || !g.log) return result("unknown");
      const ids = g.mission.expected.tickets.filter((id) => {
        const before = g.seed?.tickets[id];
        const after = g.after?.tickets[id];
        const actions = mutations(g.log ?? []).filter((e) => String(e.details.id) === id);
        return (
          before &&
          after &&
          before.status === "open" &&
          after.status === "closed" &&
          JSON.stringify(after.comments) === JSON.stringify([...before.comments, oracle.comment]) &&
          actions.length === 2 &&
          actions[0]?.op === "ticket_comment" &&
          actions[0].details.comment === oracle.comment &&
          actions[1]?.op === "ticket_close" &&
          actions[0].seq < actions[1].seq
        );
      });
      return count(ids.length, ids);
    }
    case "orders_new": {
      if (!g.seed || !g.after) return result("unknown");
      const orders = Object.values(g.after.orders).filter((o) => !g.seed?.orders[o.id]);
      const matching = orders.filter(
        (o) =>
          o.customerId === oracle.customerId &&
          o.sku === oracle.sku &&
          o.quantity === oracle.quantity,
      );
      return count(matching.length, {
        matching: matching.map((o) => o.id),
        allNew: orders.map((o) => o.id),
      });
    }
    case "no_unexpected_changes": {
      if (!g.seed || !g.after) return result("unknown");
      const allowed = oracle.allowed.flatMap((p) =>
        p.includes("{ticket}")
          ? g.mission.expected.tickets.map((id) => p.replaceAll("{ticket}", id))
          : [p],
      );
      const changes = unexpectedChanges(g.seed, g.after, allowed);
      return result(changes.length === 0 ? "pass" : "fail", changes);
    }
  }
}
