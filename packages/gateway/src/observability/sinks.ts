// The observability sink loader (ADR-0046 decision 3). The table below is the release's bundled
// entry points and the only way to obtain a sink: `OBSERVABILITY_SINK` selects one by id, and an
// id the table does not hold is refused. Nothing is loaded from a path, a URL or the environment
// (ADR-0017 amendment 1 reading); a new sink is a new line here in a new release.

import { dirname, join } from "node:path";
import type { ObservabilitySinkRuntime } from "@deskmates/contracts";
import type { ObservabilitySettings } from "../config/observability.js";
import { createSqliteSink } from "./sqlite-sink.js";

export interface SinkContext {
  settings: ObservabilitySettings;
  /** The ledger's path; the SQLite sink's default file sits beside it. */
  dbPath: string;
  now?: () => Date;
}

type SinkEntryPoint = (context: SinkContext) => ObservabilitySinkRuntime;

/** `obs.sqlite` beside `gateway.sqlite` unless `OBSERVABILITY_SQLITE_PATH` names another file. */
export function sqlitePathOf(settings: ObservabilitySettings, dbPath: string): string {
  if (settings.sqlitePath) return settings.sqlitePath;
  if (dbPath === ":memory:")
    throw new Error("OBSERVABILITY_SQLITE_PATH is required when the Gateway database is in memory");
  return join(dirname(dbPath), "obs.sqlite");
}

export const BUNDLED_SINKS: Readonly<Record<string, SinkEntryPoint>> = {
  sqlite: ({ settings, dbPath, now }) =>
    createSqliteSink({
      path: sqlitePathOf(settings, dbPath),
      ...(settings.retentionDays === undefined ? {} : { retentionDays: settings.retentionDays }),
      ...(now ? { now } : {}),
    }),
};

export function loadSink(context: SinkContext): ObservabilitySinkRuntime {
  const id = context.settings.sink as string;
  const entry = Object.hasOwn(BUNDLED_SINKS, id) ? BUNDLED_SINKS[id] : undefined;
  if (!entry) throw new Error(`observability sink "${id}" is not bundled in this release`);
  const sink = entry(context);
  if (sink.manifest.id !== id)
    throw new Error(`observability sink "${id}" declares the id "${sink.manifest.id}"`);
  return sink;
}
