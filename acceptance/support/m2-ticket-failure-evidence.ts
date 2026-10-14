// Preserve an interrupted ticket arm's evidence before the stack teardown removes its database.
// These diagnostic reads never decide the canonical ticket oracle.
import type { RunId } from "@deskmates/contracts";
import { PASSWORD } from "@deskmates/golden-site";
import type { Stack } from "./start-stack.js";

const TICKET_IDS = ["1012", "1015", "1024", "1036", "1050", "1058"] as const;

function safeText(value: unknown, secrets: readonly string[]): string {
  let text = String(value);
  for (const secret of secrets)
    if (secret.length >= 4) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}

export function ticketFailureDiagnostics(stack: Stack, runIds: readonly string[]): unknown {
  const secrets = [
    stack.config.modelAuthToken,
    stack.config.operatorToken,
    stack.config.secretsKey,
    PASSWORD,
  ];
  const tickets = stack.site.state.view().tickets;
  return {
    source: "in-process diagnostic only; not the canonical HTTP oracle",
    observedAt: new Date().toISOString(),
    tickets: Object.fromEntries(
      TICKET_IDS.map((id) => {
        const ticket = tickets[id];
        return [
          id,
          ticket && {
            status: ticket.status,
            assignee: safeText(ticket.assignee, secrets),
            tags: ticket.tags.map((tag) => safeText(tag, secrets)),
            comments: ticket.comments.map((comment) => safeText(comment, secrets)),
          },
        ];
      }),
    ),
    ticketOperations: stack.site.state
      .opLog()
      .filter((entry) => entry.op.startsWith("ticket_"))
      .map((entry) => ({
        seq: entry.seq,
        op: entry.op,
        ts: entry.ts,
        // The operation log can contain a model-written comment. Keep only the ticket fields.
        details: Object.fromEntries(
          ["id", "label", "assignee", "comment"]
            .filter((key) => typeof entry.details[key] === "string")
            .map((key) => [key, safeText(entry.details[key], secrets)]),
        ),
      })),
    runs: runIds.map((id) => {
      try {
        const run = stack.app.deskmates.ctx.runs.get(id as RunId);
        const events = stack.app.deskmates.ctx.events.list(id as RunId);
        return {
          id,
          status: run?.status ?? "missing",
          attempt: run?.attempt,
          createdAt: run?.createdAt,
          startedAt: run?.startedAt,
          finishedAt: run?.finishedAt,
          error: run?.error === undefined ? undefined : safeText(run.error, secrets),
          // Event payloads may contain page text, screenshots, or credentials. Retain only
          // ordering and kind, enough to distinguish run termination from lost status reads.
          events: events.map(({ seq, attempt, kind, ts }) => ({ seq, attempt, kind, ts })),
        };
      } catch (error) {
        return { id, diagnosticReadError: safeText(error, secrets) };
      }
    }),
  };
}

export async function readTicketArm<TRun, TEvent, TState>(args: {
  waited: PromiseSettledResult<TRun>[];
  runIds: readonly string[];
  arm: Record<string, unknown>;
  readRun: (id: string) => Promise<TRun>;
  readEvents: (run: TRun) => Promise<TEvent>;
  readState: () => Promise<TState>;
  diagnostics: () => unknown;
  secrets: readonly string[];
}): Promise<{ runs: TRun[]; events: TEvent[]; after: TState }> {
  const { waited, runIds, arm, readRun, readEvents, readState, diagnostics, secrets } = args;
  // This assignment must precede every fallback HTTP read: that read may fail too.
  arm.waitErrors = waited
    .filter((result) => result.status === "rejected")
    .map((result) => safeText(result.reason, secrets));
  try {
    const runs = await Promise.all(
      waited.map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        const id = runIds[index];
        if (!id) throw new Error("Missing started run for failed wait");
        return readRun(id);
      }),
    );
    const events = await Promise.all(runs.map(readEvents));
    const after = await readState();
    return { runs, events, after };
  } catch (error) {
    arm.statusReadError = safeText(error, secrets);
    try {
      arm.diagnostics = diagnostics();
    } catch (diagnosticError) {
      arm.diagnosticReadError = safeText(diagnosticError, secrets);
    }
    throw error;
  }
}
