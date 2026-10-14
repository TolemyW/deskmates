// Welcome delivery on the Gateway side (ADR-0024 amendment 2, decision 11; issue #122). The
// predicate is contracts' `welcomeDelivery`; this module only reads which welcome runs left a
// bot-authored message in their own private chat. `thread_messages(run_id)` is indexed.

import {
  type Run,
  type RunId,
  type WelcomeDelivery,
  type WelcomeMessage,
  isWelcomeGreeting,
  welcomeDelivery,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

type WelcomeRun = Pick<Run, "id" | "botId" | "threadId" | "status" | "triggerKind">;

interface GreetingRow {
  thread_id: string;
  author_id: string;
  run_id: string;
}

/** The welcome runs among `runs` that posted a greeting attributable to them. One query. */
export function welcomeGreetingsPosted(db: GatewayDb, runs: readonly WelcomeRun[]): Set<RunId> {
  const welcomes = runs.filter((run) => run.triggerKind === "welcome");
  const posted = new Set<RunId>();
  if (welcomes.length === 0) return posted;
  const rows = db
    .prepare(
      `SELECT thread_id, author_id, run_id FROM thread_messages
        WHERE author_kind = 'bot' AND run_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(welcomes.map((run) => run.id))) as GreetingRow[];
  const byId = new Map(welcomes.map((run) => [run.id as string, run]));
  for (const row of rows) {
    const run = byId.get(row.run_id);
    const message: WelcomeMessage = {
      threadId: row.thread_id as WelcomeMessage["threadId"],
      authorKind: "bot",
      authorId: row.author_id,
      runId: row.run_id as RunId,
    };
    if (run && isWelcomeGreeting(run, message)) posted.add(run.id);
  }
  return posted;
}

/** Where one welcome run stands. */
export function welcomeDeliveryOf(db: GatewayDb, run: WelcomeRun): WelcomeDelivery {
  return welcomeDelivery(run, welcomeGreetingsPosted(db, [run]).has(run.id));
}
