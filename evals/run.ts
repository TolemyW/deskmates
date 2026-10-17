#!/usr/bin/env node
// `npm run evals` (issue #11): replay every committed run trace under `evals/traces/` through the
// current sidecar code with the fake SDK and diff each decision point against the ledger
// (measurement §5.1, `replay.ts`). Zero tokens, no Docker, no network, so it is safe on every
// PR. An empty trace set is not a failure: it says so and exits 0.
//
// Traces get there from a Gateway: `npm run replay -- export --gateway <url> --run <id>`, the
// command a run drawer's "Save as replay fixture" shows. The model-in-the-loop deskbench runner
// (N tasks x K repeats on the golden site) is a separate, later tool; it is not this script.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as replayMain } from "./replay.js";

export const TRACES_DIR = "evals/traces";

type Log = (line: string) => void;

/** The `.json` traces in `dir`, sorted; a missing directory has none. */
export async function traceFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Exit code: 0 when every trace replays identically (or there are none), 1 on a mismatch. */
export async function runEvals(
  dir: string = TRACES_DIR,
  log: Log = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const files = await traceFiles(dir);
  if (files.length === 0) {
    log(`No replay traces in ${dir}; nothing to replay.`);
    log(
      "Add one with `npm run replay -- export --gateway <url> --run <runId>` (a run drawer's " +
        '"Save as replay fixture" shows the exact command), then commit the JSON next to the ' +
        "change it guards.",
    );
    return 0;
  }
  log(`Replaying ${files.length} trace(s) from ${dir}.`);
  return replayMain(["replay", ...files], log);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  runEvals(process.argv[2] ?? TRACES_DIR).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(2);
    },
  );
}
