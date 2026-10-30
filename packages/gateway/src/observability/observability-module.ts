// The observability Gateway module (ADR-0046 decision 2): the collector on a timer, its sink,
// and the status the root reads (decision 8). Built by `buildGateway` only when
// `OBSERVABILITY_SINK` is set; otherwise nothing here runs. With a vector sink and an ADR-0041
// embedding service it also runs the failure retrospective after the collector (amendment 2
// decision 23), unless `OBSERVABILITY_RETROSPECTIVE=off`.
//
// Data flows one way, ledger to sink (decision 10): no Gateway decision reads anything this
// module holds. The only readers are the status route and the module's own collector, which
// `import-graph.test.ts` enforces. The module is attached to its context through a WeakMap
// rather than a context field, so the shared context gains no observability dependency.

import { dirname, join } from "node:path";
import type { ObservabilitySinkRuntime, ObservabilityStatus } from "@deskmates/contracts";
import type { GatewayConfig } from "../config.js";
import type { ObservabilitySettings } from "../config/observability.js";
import type { GatewayDb } from "../db/open.js";
import type { RetrievalFetch } from "../retrieval/clients.js";
import { Collector } from "./collector.js";
import { Retrospective } from "./retrospective.js";
import { loadSink } from "./sinks.js";
import type { Fault } from "./spool.js";

/** How often an idle collector looks at the ledger. A batch still closes on its own schedule. */
export const OBSERVABILITY_POLL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
/** How often the timer runs the retrospective when it has no backlog. */
export const RETROSPECTIVE_INTERVAL_MS = 60_000;

export interface ObservabilityModule {
  readonly settings: ObservabilitySettings;
  /** Start the timer; `buildGateway` does this with the cron runners. */
  start(): void;
  /** Stop the timer, wait for a tick in flight, close the sink. The spool stays for next start. */
  stop(): Promise<void>;
  /** One collector step, then a retrospective step; the timer calls it, T1 tests directly. */
  tick(): Promise<void>;
  /** Read, close the open batch whatever its age, and commit it (tests; a future flush). */
  flush(): Promise<void>;
  status(): Promise<ObservabilityStatus>;
}

export interface ObservabilityModuleOptions {
  db: GatewayDb;
  config: GatewayConfig;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** T1 only: a sink instead of the configured one, a clock, crash points, a spool directory. */
  sink?: ObservabilitySinkRuntime;
  now?: () => Date;
  fault?: Fault;
  spoolDir?: string;
  pollMs?: number;
  /** T1 only: the embedding service's fetch, for a fake server. */
  fetch?: RetrievalFetch;
}

/** The spool sits beside the ledger, or beside the observability file for an in-memory ledger. */
export function spoolDirOf(config: GatewayConfig): string {
  if (config.dbPath !== ":memory:") return join(dirname(config.dbPath), "observability-spool");
  const path = config.observability?.sqlitePath;
  if (path) return join(dirname(path), "observability-spool");
  throw new Error("the observability spool needs a Gateway database file");
}

export function createObservabilityModule(
  options: ObservabilityModuleOptions,
): ObservabilityModule | undefined {
  const settings = options.config.observability;
  if (!settings) return undefined;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const sink =
    options.sink ??
    loadSink({ settings, dbPath: options.config.dbPath, ...(options.now ? { now } : {}) });
  const spoolDir = options.spoolDir ?? spoolDirOf(options.config);
  const embedding = options.config.retrieval?.embedding;
  const retrospective =
    settings.retrospective && sink.manifest.capabilities.vectors && sink.vectors && embedding
      ? new Retrospective({
          db: options.db,
          vectors: sink.vectors,
          embedding,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.now ? { now } : {}),
        })
      : undefined;
  let retrospectiveDue = 0;
  let retrospectiveBacklog = false;
  let collector: Collector | undefined;
  let lastError: ObservabilityStatus["lastError"] = null;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const fresh = () =>
    new Collector({
      db: options.db,
      sink,
      spoolDir,
      settings,
      now,
      ...(options.fault ? { fault: options.fault } : {}),
    });

  /** One step; after any failure the next step recovers from disk, never from memory. */
  const step = async (flush: boolean, force: boolean): Promise<boolean> => {
    try {
      if (!collector) {
        const next = fresh();
        await next.init();
        collector = next;
      }
      const { backlog } = await collector.tick(flush);
      failures = 0;
      await retrospect(force);
      return backlog || retrospectiveBacklog;
    } catch (err) {
      collector = undefined;
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      lastError = { at: now().toISOString(), message };
      log("observability collector step failed", { error: message, failures });
      throw err;
    }
  };

  /**
   * A retrospective step when one is due, or always when `force` (a direct tick or a flush). Its
   * failure is its own: it is logged and shown on the status route, and never fails the
   * collector or holds its batches.
   */
  const retrospect = async (force: boolean): Promise<void> => {
    if (!retrospective) return;
    const at = now().getTime();
    if (!force && !retrospectiveBacklog && at < retrospectiveDue) return;
    retrospectiveDue = at + RETROSPECTIVE_INTERVAL_MS;
    try {
      retrospectiveBacklog = (await retrospective.step()).backlog;
    } catch (err) {
      retrospectiveBacklog = false;
      log("observability retrospective step failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const run = (flush: boolean, force = flush): Promise<boolean> => {
    const previous = running ?? Promise.resolve();
    const next = previous.then(() => step(flush, force));
    running = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      run(false).then(
        (backlog) => schedule(backlog ? 0 : (options.pollMs ?? OBSERVABILITY_POLL_MS)),
        () =>
          schedule(
            Math.min(MAX_BACKOFF_MS, (options.pollMs ?? OBSERVABILITY_POLL_MS) * 2 ** failures),
          ),
      );
    }, delay);
    timer.unref?.();
  };

  return {
    settings,
    start() {
      stopped = false;
      if (!timer) schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
      await sink.close();
    },
    async tick() {
      await run(false, true);
    },
    async flush() {
      await run(true);
    },
    async status() {
      const state = collector?.spoolState();
      const newestClosed = state?.closed[state.closed.length - 1];
      const committed = state?.committed;
      const newest = newestClosed
        ? { batchId: newestClosed.batchId, closedAt: newestClosed.closedAt, committed: false }
        : committed?.batchId && committed.committedAt
          ? { batchId: committed.batchId, closedAt: committed.committedAt, committed: true }
          : null;
      let sinkStats: ObservabilityStatus["sinkStats"] = null;
      try {
        sinkStats = sink.stats ? await sink.stats() : null;
      } catch {
        sinkStats = null;
      }
      return {
        enabled: true,
        grafanaUrl: options.config.observabilityGrafanaUrl ?? null,
        sink: {
          id: sink.manifest.id,
          version: sink.manifest.version,
          engine: sink.manifest.engine,
          contractVersion: sink.manifest.contractVersion,
        },
        payloads: settings.payloads,
        batchSeconds: settings.batchSeconds,
        batchBytes: settings.batchBytes,
        retentionDays: settings.retentionDays ?? null,
        tables: (collector ?? fresh()).tables(),
        newestBatch: newest
          ? {
              ...newest,
              ageSeconds: Math.max(
                0,
                Math.round((now().getTime() - Date.parse(newest.closedAt)) / 1000),
              ),
            }
          : null,
        openBatch: state?.open
          ? {
              batchId: state.open.batchId,
              openedAt: state.open.openedAt,
              bytes: state.open.bytes,
            }
          : null,
        pendingBatches: state?.closed.length ?? 0,
        spoolBytes: collector?.spoolBytes() ?? 0,
        sinkStats,
        lastError,
        retrospective: retrospective?.status() ?? null,
      };
    },
  };
}

const modules = new WeakMap<object, ObservabilityModule>();

/** Attach the module to the Gateway context it reads; `buildGateway` calls it once. */
export function attachObservability(owner: object, module: ObservabilityModule): void {
  modules.set(owner, module);
}

/** The module of a Gateway context, if observability is configured. The status route only. */
export function observabilityOf(owner: object): ObservabilityModule | undefined {
  return modules.get(owner);
}
