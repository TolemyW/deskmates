// Pull run traces out of a live Gateway over the operator API. Read-only: five GETs, no internal
// route, no database file, nothing that could change a run. Every trace is checked against the
// secret shapes before it is written, so a broken redactor upstream stops here instead of being
// committed into `evals/traces/`.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordedSkillSet } from "@deskmates/contracts";
import type {
  ApiBot,
  ApiRun,
  ApiRunEvent,
  ApiWorkspace,
  RunTrace,
  TraceMemoryVersion,
  TraceSkillVersion,
  TraceUsage,
} from "./trace.js";
import { assertNoSecrets, buildTrace, recordedMemoryIndex } from "./trace.js";

export type Fetch = typeof globalThis.fetch;

export interface ExportOptions {
  gateway: string;
  /** Only runs created at or after this ISO timestamp. */
  since?: string;
  /** Specific run ids; when given, `since` is ignored. */
  runIds?: readonly string[];
  fetch?: Fetch;
  now?: () => Date;
}

async function getJson<T>(fetchFn: Fetch, url: string): Promise<T> {
  const response = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** Terminal runs only: a run still going will not replay to the same place. */
function isReplayable(run: ApiRun): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "silent" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

export async function exportTraces(opts: ExportOptions): Promise<RunTrace[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.gateway.replace(/\/+$/, "");
  const now = opts.now ?? (() => new Date());
  const exportedAt = now().toISOString();

  let runs: ApiRun[];
  if (opts.runIds !== undefined && opts.runIds.length > 0) {
    runs = [];
    for (const id of opts.runIds) {
      const { run } = await getJson<{ run: ApiRun }>(fetchFn, `${base}/api/runs/${id}`);
      runs.push(run);
    }
  } else {
    // The run list is a newest-first keyset page (#113 slice R): follow it until the cutoff.
    const listed: ApiRun[] = [];
    let cursor: string | undefined;
    do {
      const page = await getJson<{ runs: ApiRun[]; nextCursor?: string }>(
        fetchFn,
        `${base}/api/runs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      listed.push(...page.runs);
      const oldest = page.runs.at(-1)?.createdAt ?? "";
      cursor = opts.since !== undefined && oldest < opts.since ? undefined : page.nextCursor;
    } while (cursor);
    runs = listed.reverse().filter((run) => {
      if (!isReplayable(run)) return false;
      if (opts.since === undefined) return true;
      return (run.createdAt ?? "") >= opts.since;
    });
  }

  const bots = new Map<string, ApiBot>();
  const workspaces = new Map<string, ApiWorkspace>();
  const traces: RunTrace[] = [];

  for (const listedRun of runs) {
    const detail = await getJson<{ run: ApiRun; usage?: TraceUsage[] }>(
      fetchFn,
      `${base}/api/runs/${listedRun.id}`,
    );
    const run = detail.run;
    // Every event, read as bounded tails after the last seq seen (#113 slice R).
    const events: ApiRunEvent[] = [];
    for (let more = true; more; ) {
      const tail = await getJson<{ events: ApiRunEvent[]; hasMore?: boolean }>(
        fetchFn,
        `${base}/api/runs/${run.id}/events?afterSeq=${events.at(-1)?.seq ?? 0}`,
      );
      events.push(...tail.events);
      more = tail.hasMore === true && tail.events.length > 0;
    }
    let bot = bots.get(run.botId);
    if (bot === undefined) {
      bot = (await getJson<{ bot: ApiBot }>(fetchFn, `${base}/api/bots/${run.botId}`)).bot;
      bots.set(run.botId, bot);
    }
    let workspace = workspaces.get(bot.workspaceId);
    if (workspace === undefined) {
      workspace = (
        await getJson<{ workspace: ApiWorkspace }>(
          fetchFn,
          `${base}/api/workspaces/${bot.workspaceId}`,
        )
      ).workspace;
      workspaces.set(bot.workspaceId, workspace);
    }
    const recorded = recordedMemoryIndex(run.config ?? {});
    const memoryVersions =
      recorded && recorded.versionSet.length > 0
        ? (
            await getJson<{ versions: TraceMemoryVersion[] }>(
              fetchFn,
              `${base}/api/memory/versions?refs=${encodeURIComponent(
                recorded.versionSet.map((ref) => `${ref.entryId}@${ref.version}`).join(","),
              )}`,
            )
          ).versions
        : undefined;
    // ADR-0015 decision 7: exactly the skill versions the run recorded, so replay can rebuild them.
    const skillRefs = recordedSkillSet(run.config ?? {})?.set ?? [];
    const skillVersions =
      skillRefs.length > 0
        ? (
            await getJson<{ versions: TraceSkillVersion[] }>(
              fetchFn,
              `${base}/api/skills/versions?refs=${encodeURIComponent(
                skillRefs.map((ref) => `${ref.skillId}@${ref.version}`).join(","),
              )}`,
            )
          ).versions.map(({ skillId, version, name, sha256, files }) => ({
            skillId,
            version,
            name,
            sha256,
            files,
          }))
        : undefined;
    const trace = buildTrace({
      gateway: base,
      exportedAt,
      run,
      events,
      ...(memoryVersions === undefined ? {} : { memoryVersions }),
      ...(skillVersions === undefined ? {} : { skillVersions }),
      ...(detail.usage === undefined ? {} : { usage: detail.usage }),
      bot,
      workspace,
    });
    assertNoSecrets(trace);
    traces.push(trace);
  }

  return traces;
}

/** One trace per file, `<runId>.json`, so a PR can carry the two or three it cares about. */
export async function writeTraces(traces: readonly RunTrace[], outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const trace of traces) {
    const file = path.join(outDir, `${trace.run.id}.json`);
    await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
    written.push(file);
  }
  return written;
}
