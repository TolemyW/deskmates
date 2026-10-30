// T0 static check (ADR-0005 amendment 3, rewritten decision 26): a paused thread becomes active
// only on a human message (a turn-budget pause), Resume, or the end of a turn-budget pause's
// reset window. Those are the three `ThreadStore.resume` callers in the router, and the store's
// `resume` is the only SQL that sets a thread active. A new caller (an approval decision, an
// expiry, a reminder, a sweep, a bot message) fails here until the ADR says otherwise.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** The method each match sits in: the nearest preceding class-member header. */
function enclosingMethod(text: string, index: number): string {
  const before = text.slice(0, index);
  const headers = [...before.matchAll(/^ {2}(?:private )?([a-zA-Z]+)\(/gm)];
  return headers.at(-1)?.[1] ?? "?";
}

describe("what may set a paused thread active (rewritten decision 26)", () => {
  const files = sources(SRC).map((path) => ({
    path: relative(SRC, path),
    text: readFileSync(path, "utf8"),
  }));

  it("calls ThreadStore.resume only from the human message, Resume and the reset window", () => {
    const callers = files.flatMap(({ path, text }) =>
      [...text.matchAll(/threads\.resume\(/g)].map(
        (match) => `${path}:${enclosingMethod(text, match.index)}`,
      ),
    );
    expect(callers.sort()).toEqual([
      "threads/router.ts:operatorResume",
      "threads/router.ts:postHuman",
      "threads/router.ts:resumeDuePauses",
    ]);
  });

  it("sets a thread active in SQL only inside ThreadStore.resume", () => {
    const writers = files.flatMap(({ path, text }) =>
      [...text.matchAll(/UPDATE threads SET (?:[a-z_]+ = [^,]+, )*status = 'active'/g)].map(
        (match) => `${path}:${enclosingMethod(text, match.index)}`,
      ),
    );
    expect(writers).toEqual(["threads/threads.ts:resume"]);
  });
});
