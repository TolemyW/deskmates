// The small argument and file helpers the two campaign CLIs share.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseObservations } from "./observation.js";

export interface Parsed {
  positional: string[];
  options: Map<string, string>;
}

/** `--name value` and `--name=value`; `--json` is a flag. */
export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg === "--json") options.set("json", "true");
    else if (eq !== -1) options.set(arg.slice(2, eq), arg.slice(eq + 1));
    else {
      options.set(arg.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  return { positional, options };
}

/** Every observation in the `*.json` files of the given report directories, sorted by name. */
export function readObservations(dirs: readonly string[]): unknown[] {
  return dirs.flatMap((dir) =>
    parseObservations(
      readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => ({ name: path.join(dir, f), text: readFileSync(path.join(dir, f), "utf8") })),
    ),
  );
}

/**
 * The line `decide` prints when any row came from the scripted dry run (protocol amendment 1 A4):
 * its answers were scripted, so its decision checks the harness and is not evidence.
 */
export function dryRunNote(rows: readonly Record<string, unknown>[]): string | undefined {
  const dry = rows.filter(
    (r) => (r.config as { dryRun?: unknown } | undefined)?.dryRun === "scripted",
  ).length;
  return dry === 0
    ? undefined
    : `dry run: ${dry} of ${rows.length} rows came from the scripted upstream; this decision checks the harness and is not evidence`;
}
