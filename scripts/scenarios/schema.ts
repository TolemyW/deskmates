import { createHash } from "node:crypto";
import {
  type ReasoningOverrides,
  egressAllowlistProblem,
  isEffortLevel,
  isThinkingConfig,
} from "../../packages/contracts/src/index.js";

export interface ScenarioBot extends ReasoningOverrides {
  name: string;
  role: string;
  soul: string;
  manualMemory?: string;
  model?: string;
  cheapModel?: string;
  messageAllowlist: string[];
  /** Kept for review; v1 never enables schedules when importing. */
  cron: { schedule: string; prompt: string }[];
  /** Local connector registrations must be supplied through environment bindings. */
  connectors: string[];
}

export interface Scenario {
  schemaVersion: 1;
  name: string;
  workspace: {
    name: string;
    sandboxProvider: "docker";
    egressAllowlist: string[];
    probe?: { url: string; expectText: string };
  };
  bots: ScenarioBot[];
  threads: { key: string; title: string; members: string[] }[];
  tasks: {
    name: string;
    thread: string;
    message: string;
    timeoutSeconds: number;
    expectReply?: { contains: string; bot?: string };
  }[];
}

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object");
  return value as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]): void {
  check(
    Object.keys(v).every((k) => allowed.includes(k)),
    "Unknown field in scenario",
  );
}
function text(v: unknown, max = 65536, empty = false): asserts v is string {
  check(
    typeof v === "string" && (empty || v.trim().length > 0) && Buffer.byteLength(v) <= max,
    "Invalid text field",
  );
}
function array(v: unknown, max: number): asserts v is unknown[] {
  check(Array.isArray(v) && v.length <= max, "Invalid array field");
}
function names(v: unknown): asserts v is string[] {
  array(v, 100);
  for (const n of v) {
    text(n, 128);
    check(/^[\w-]+$/.test(n), "Invalid reference name");
  }
  check(
    new Set((v as string[]).map((n) => n.toLowerCase())).size === v.length,
    "Duplicate reference name",
  );
}

/** Strict allowlist: credentials and opaque runtime state have no schema fields. */
export function parseScenario(value: unknown): Scenario {
  const s = record(value);
  keys(s, ["schemaVersion", "name", "workspace", "bots", "threads", "tasks"]);
  check(s.schemaVersion === 1, "Unsupported scenario schemaVersion");
  text(s.name, 200);
  const w = record(s.workspace);
  keys(w, ["name", "sandboxProvider", "egressAllowlist", "probe"]);
  text(w.name, 200);
  check(w.sandboxProvider === "docker", "v1 supports Docker workspaces only");
  array(w.egressAllowlist, 100);
  for (const host of w.egressAllowlist) text(host, 253);
  check(
    egressAllowlistProblem(w.egressAllowlist as string[]) === undefined,
    "Invalid egress allowlist",
  );
  if (w.probe !== undefined) {
    const p = record(w.probe);
    keys(p, ["url", "expectText"]);
    text(p.url, 2048);
    text(p.expectText, 4096, true);
    const url = new URL(p.url);
    check(
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password,
      "Invalid probe URL",
    );
  }
  array(s.bots, 100);
  check(s.bots.length > 0, "At least one bot is required");
  const botNames: string[] = [];
  for (const raw of s.bots) {
    const b = record(raw);
    keys(b, [
      "name",
      "role",
      "soul",
      "manualMemory",
      "model",
      "cheapModel",
      "effort",
      "thinking",
      "messageAllowlist",
      "cron",
      "connectors",
    ]);
    names([b.name]);
    botNames.push(b.name as string);
    text(b.role, 4096, true);
    text(b.soul, 65536, true);
    if (b.manualMemory !== undefined) text(b.manualMemory, 65536, true);
    for (const field of ["model", "cheapModel"]) if (b[field] !== undefined) text(b[field], 200);
    check(b.effort === undefined || isEffortLevel(b.effort), "Invalid effort");
    check(b.thinking === undefined || isThinkingConfig(b.thinking), "Invalid thinking");
    names(b.messageAllowlist);
    names(b.connectors);
    array(b.cron, 100);
    for (const rawCron of b.cron) {
      const c = record(rawCron);
      keys(c, ["schedule", "prompt"]);
      text(c.schedule, 100);
      text(c.prompt);
    }
  }
  names(botNames);
  for (const raw of s.bots) {
    const b = raw as ScenarioBot;
    check(
      b.messageAllowlist.every((n) => botNames.includes(n) && n !== b.name),
      "Unknown or self messageAllowlist reference",
    );
  }
  array(s.threads, 100);
  const threadKeys: string[] = [];
  for (const raw of s.threads) {
    const t = record(raw);
    keys(t, ["key", "title", "members"]);
    names([t.key]);
    threadKeys.push(t.key as string);
    text(t.title, 1000, true);
    names(t.members);
    check(
      t.members.length > 0 && t.members.length <= 6 && t.members.every((n) => botNames.includes(n)),
      "Invalid thread membership",
    );
  }
  names(threadKeys);
  array(s.tasks, 100);
  for (const raw of s.tasks) {
    const t = record(raw);
    keys(t, ["name", "thread", "message", "timeoutSeconds", "expectReply"]);
    text(t.name, 200);
    text(t.message);
    check(typeof t.thread === "string" && threadKeys.includes(t.thread), "Unknown task thread");
    check(
      Number.isInteger(t.timeoutSeconds) &&
        Number(t.timeoutSeconds) >= 1 &&
        Number(t.timeoutSeconds) <= 1800,
      "Task timeout must be 1..1800 seconds",
    );
    if (t.expectReply !== undefined) {
      const e = record(t.expectReply);
      keys(e, ["contains", "bot"]);
      text(e.contains);
      if (e.bot !== undefined)
        check(typeof e.bot === "string" && botNames.includes(e.bot), "Unknown oracle bot");
    }
  }
  return structuredClone(s) as unknown as Scenario;
}

/** Canonical hash does not depend on JSON key order. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
