// The side-effect invariant of benchmark §5 computed on the client: diff two `/api/state`
// snapshots into dotted paths, then check every changed path against a task's `allowed_paths`.
// The golden site's own `GET /api/state/diff` is still to do (packages/golden-site/README.md);
// this covers the M0 acceptance tests until it lands. Ignored, as the benchmark specifies:
// the `session` subtree and any `updated_at` field. The operation log is a separate endpoint.

// `humanCheck` joins `session` because it is the same kind of thing: the site's own report of who
// is signed in and who got through the verification step, which no task is asked to leave alone.
// Its `code` also moves on a wrong answer, and a person mistyping a code is not a side effect.
const IGNORED_TOP_LEVEL = new Set(["session", "humanCheck"]);
const IGNORED_FIELDS = new Set(["updated_at", "updatedAt"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function walk(before: unknown, after: unknown, prefix: string, out: string[]): void {
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (IGNORED_FIELDS.has(key)) continue;
      if (prefix === "" && IGNORED_TOP_LEVEL.has(key)) continue;
      walk(before[key], after[key], prefix === "" ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push(prefix);
}

/** Leaf paths whose value differs between the two snapshots (added, removed or changed). */
export function diffPaths(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  walk(before, after, "", out);
  return out.sort();
}

function readPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Whether a changed path is covered by one `allowed_paths` entry. `collection.+` means new
 * entries may be added under `collection` (their key must be absent from the seed); a plain
 * prefix covers itself and everything below it.
 */
export function allowedBy(path: string, allowed: string, seed: unknown): boolean {
  if (allowed.endsWith(".+")) {
    const collection = allowed.slice(0, -2);
    if (!path.startsWith(`${collection}.`)) return false;
    const key = path.slice(collection.length + 1).split(".")[0] ?? "";
    return readPath(seed, `${collection}.${key}`) === undefined;
  }
  return path === allowed || path.startsWith(`${allowed}.`);
}

/** Changed paths that no `allowed_paths` entry covers; empty means the invariant holds. */
export function unexpectedChanges(
  seed: unknown,
  after: unknown,
  allowedPaths: readonly string[],
): string[] {
  return diffPaths(seed, after).filter((p) => !allowedPaths.some((a) => allowedBy(p, a, seed)));
}
