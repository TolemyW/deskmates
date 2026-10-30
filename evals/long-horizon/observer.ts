// Read-only operator API observer, usable on the isolated stack or an existing deployment.
import type {
  RunContextMetrics,
  RunEvent,
  RunTimeline,
  RunUsageReceipt,
  UsageCoverage,
} from "@deskmates/contracts";
import type { Stack } from "../../acceptance/support/start-stack.js";
import { type RunObservation, observeRun } from "./metrics.js";

export type OperatorReader = Pick<Stack, "api">;
function boundedReader(api: OperatorReader): OperatorReader {
  const deadline = Date.now() + 30_000;
  return {
    api: async (method, path, body, options) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("observer deadline");
      const signal = AbortSignal.timeout(Math.min(remaining, 10_000));
      return api.api(method, path, body, {
        signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal,
      });
    },
  };
}
interface RunDetail {
  run: {
    id: string;
    status: string;
    attempt: number;
    threadId?: string;
    config?: Record<string, unknown>;
  };
  usage: RunUsageReceipt[];
  usageCoverage: UsageCoverage;
}

async function read<T>(api: OperatorReader, path: string): Promise<T> {
  const result = await api.api<T>("GET", path, undefined, { signal: AbortSignal.timeout(10_000) });
  if (result.status !== 200) throw new Error(`observer GET failed: ${result.status}`);
  return result.json;
}

export async function observeRunById(source: OperatorReader, id: string): Promise<RunObservation> {
  const api = boundedReader(source);
  const detail = await read<RunDetail>(api, `/api/runs/${encodeURIComponent(id)}`);
  const timeline = await read<RunTimeline>(api, `/api/runs/${encodeURIComponent(id)}/timeline`);
  const context = await read<RunContextMetrics>(api, `/api/runs/${encodeURIComponent(id)}/context`);
  const events: RunEvent[] = [];
  for (;;) {
    const page = await read<{ events: RunEvent[]; hasMore?: boolean }>(
      api,
      `/api/runs/${encodeURIComponent(id)}/events?afterSeq=${events.at(-1)?.seq ?? 0}`,
    );
    if (
      page.hasMore &&
      (!page.events.length || (page.events.at(-1)?.seq ?? 0) <= (events.at(-1)?.seq ?? 0))
    )
      throw new Error("observer event pagination made no progress");
    events.push(...page.events);
    if (!page.hasMore) break;
  }
  let reply: string | undefined;
  if (detail.run.threadId) {
    let after = 0;
    for (;;) {
      const page = await read<{
        messages: { seq: number; authorKind: string; runId?: string; body: string }[];
        hasMore?: boolean;
      }>(api, `/api/threads/${encodeURIComponent(detail.run.threadId)}/messages?afterSeq=${after}`);
      for (const m of page.messages) if (m.authorKind === "bot" && m.runId === id) reply = m.body;
      const last = page.messages.at(-1)?.seq ?? after;
      if (!page.hasMore) break;
      if (last <= after) throw new Error("observer transcript pagination made no progress");
      after = last;
    }
  }
  return observeRun({
    runId: id,
    status: detail.run.status,
    attempt: detail.run.attempt,
    usage: detail.usage,
    coverage: detail.usageCoverage ?? "unknown",
    events,
    timeline,
    context,
    ...(detail.run.config === undefined ? {} : { recordedConfig: detail.run.config }),
    ...(reply === undefined ? {} : { reply }),
  });
}

/** Includes jobs as well as conversational runs; no selection by a 'successful' status. */
export class RunInventoryError extends Error {
  constructor(
    message: string,
    readonly runIds: readonly string[],
  ) {
    super(message);
    this.name = "RunInventoryError";
  }
}

export async function workspaceRunIds(
  source: OperatorReader,
  workspaceId: string,
): Promise<string[]> {
  const api = boundedReader(source);
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (;;) {
      const page = await read<{ runs: { id: string }[]; nextCursor?: string }>(
        api,
        `/api/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      ids.push(...page.runs.map((r) => r.id));
      if (!page.nextCursor) return [...new Set(ids)];
      if (cursors.has(page.nextCursor)) throw new Error("observer run pagination made no progress");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  } catch (error) {
    throw new RunInventoryError(String(error), [...new Set(ids)]);
  }
}

export interface DeploymentObservation {
  runs: RunObservation[];
  errors: { runId: string; error: string }[];
  inventoryComplete: boolean;
  inventoryError?: string;
}

/** No writes, no model calls. The caller owns a private report and its credential guard. */
export async function observeDeployment(
  api: OperatorReader,
  workspaceId: string,
): Promise<DeploymentObservation> {
  const runs: RunObservation[] = [];
  const errors: { runId: string; error: string }[] = [];
  let ids: readonly string[];
  let inventoryError: string | undefined;
  try {
    ids = await workspaceRunIds(api, workspaceId);
  } catch (error) {
    ids = error instanceof RunInventoryError ? error.runIds : [];
    inventoryError = String(error);
  }
  for (const id of ids) {
    try {
      runs.push(await observeRunById(api, id));
    } catch (error) {
      errors.push({ runId: id, error: String(error) });
    }
  }
  return {
    runs,
    errors,
    inventoryComplete: inventoryError === undefined,
    ...(inventoryError === undefined ? {} : { inventoryError }),
  };
}
