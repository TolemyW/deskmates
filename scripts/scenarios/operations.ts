import type {
  BotDefinition,
  Run,
  Thread,
  ThreadMessage,
  Workspace,
} from "../../packages/contracts/src/index.js";
import {
  WORKSPACE_NAME_MAX_UNITS,
  clipWorkspaceName,
  isTerminal,
  workspaceNameUnits,
} from "../../packages/contracts/src/index.js";
import { type Api, segment } from "./client.js";
import { type Scenario, check, fingerprint, parseScenario } from "./schema.js";

/**
 * The imported workspace's name: the scenario's name, shortened by whole characters to leave room
 * for a compact import tag, inside the 32-unit bound (ADR-0034 decision 1).
 */
export function scenarioWorkspaceName(name: string, createdAt: string): string {
  const tag = `#${createdAt.replace(/[^0-9]/g, "").slice(2, 14)}`;
  const room = WORKSPACE_NAME_MAX_UNITS - workspaceNameUnits(tag) - 1;
  const base = clipWorkspaceName(name.trim(), room).trim();
  return base ? `${base} ${tag}` : tag;
}

export interface ImportReceipt {
  schemaVersion: 1;
  scenarioHash: string;
  gateway: string;
  state: "importing" | "imported" | "failed";
  workspaceId?: string;
  bots: Record<string, string>;
  threads: Record<string, string>;
  createdAt: string;
  execution?: "started" | "finished";
  error?: string;
}
type Save = (receipt: ImportReceipt) => Promise<void>;
export interface ConnectorBinding {
  url: string;
  credential?: string;
  kind?: string;
  publicUrl?: boolean;
}

/** Never serializes raw registry objects, runtime IDs, credentials or learned memories. */
export async function exportScenario(api: Api, workspaceId: string): Promise<Scenario> {
  const { workspace } = await api.request<{ workspace: Workspace }>(
    "GET",
    `/api/workspaces/${segment(workspaceId)}`,
  );
  const { bots } = await api.request<{ bots: BotDefinition[] }>(
    "GET",
    `/api/bots?workspaceId=${segment(workspaceId)}`,
  );
  const { threads } = await api.request<{ threads: Thread[] }>(
    "GET",
    `/api/threads?workspaceId=${segment(workspaceId)}`,
  );
  const byId = new Map(bots.map((b) => [b.id, b.name]));
  const byName = new Map(bots.map((b) => [b.name.toLowerCase(), b.name]));
  const exportedBots = [];
  for (const b of bots) {
    const { soul } = await api.request<{ soul: { body: string } }>(
      "GET",
      `/api/bots/${segment(b.id)}/soul`,
    );
    const { memory } = await api.request<{ memory: { body: string } }>(
      "GET",
      `/api/bots/${segment(b.id)}/memory`,
    );
    exportedBots.push({
      name: b.name,
      role: b.role,
      soul: soul.body,
      manualMemory: memory.body,
      messageAllowlist: b.messageAllowlist.map((name) => byName.get(name.toLowerCase()) ?? name),
      cron: b.cron.map(({ schedule, prompt }) => ({ schedule, prompt })),
      connectors: [...b.connectors],
      ...(b.model === undefined ? {} : { model: b.model }),
      ...(b.cheapModel === undefined ? {} : { cheapModel: b.cheapModel }),
      ...(b.effort === undefined ? {} : { effort: b.effort }),
      ...(b.thinking === undefined ? {} : { thinking: b.thinking }),
    });
  }
  const exportedThreads = [];
  for (const t of threads.filter((t) => t.kind === "chat")) {
    const { members } = await api.request<{ members: { botId: BotDefinition["id"] }[] }>(
      "GET",
      `/api/threads/${segment(t.id)}`,
    );
    exportedThreads.push({
      key: `chat-${exportedThreads.length + 1}`,
      title: t.title,
      members: members.map((m) => byId.get(m.botId)),
    });
  }
  return parseScenario({
    schemaVersion: 1,
    name: workspace.name,
    workspace: {
      name: workspace.name,
      sandboxProvider: workspace.sandboxProvider,
      egressAllowlist: [...workspace.egressAllowlist],
      ...(workspace.probe ? { probe: workspace.probe } : {}),
    },
    bots: exportedBots,
    threads: exportedThreads,
    tasks: [],
  });
}

/** Import is create-only. A partial failure is journaled; no automatic retries or deletion. */
export async function importScenario(
  api: Api,
  input: Scenario,
  save: Save,
  bindings: Record<string, ConnectorBinding> = {},
): Promise<ImportReceipt> {
  const scenario = parseScenario(input);
  const needed = [...new Set(scenario.bots.flatMap((b) => b.connectors))];
  for (const name of needed) {
    const binding = bindings[name];
    check(binding, `Missing local connector binding: ${name}`);
    const url = new URL(binding.url);
    check(
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password,
      "Invalid connector binding URL",
    );
  }
  const receipt: ImportReceipt = {
    schemaVersion: 1,
    scenarioHash: fingerprint(scenario),
    gateway: api.baseUrl,
    state: "importing",
    bots: Object.create(null),
    threads: Object.create(null),
    createdAt: new Date().toISOString(),
  };
  await save(receipt);
  try {
    const w = scenario.workspace;
    const { workspace } = await api.request<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: scenarioWorkspaceName(w.name, receipt.createdAt),
      sandboxProvider: w.sandboxProvider,
      egressAllowlist: w.egressAllowlist,
      ...(w.probe ? { probeUrl: w.probe.url, probeExpectText: w.probe.expectText } : {}),
    });
    receipt.workspaceId = workspace.id;
    await save(receipt);
    for (const name of needed)
      await api.request("POST", "/api/connectors", {
        ...bindings[name],
        workspaceId: workspace.id,
        name,
      });
    for (const b of scenario.bots) {
      const { soul, manualMemory, ...config } = b;
      const { bot } = await api.request<{ bot: BotDefinition }>("POST", "/api/bots", {
        ...config,
        workspaceId: workspace.id,
        cron: [],
      });
      receipt.bots[b.name] = bot.id;
      await save(receipt);
      for (const [file, body] of [
        ["soul", soul],
        ["memory", manualMemory],
      ] as const) {
        if (body === undefined) continue;
        const path = `/api/bots/${segment(bot.id)}/${file}`;
        const current = await api.request<Record<string, { version: string }>>("GET", path);
        await api.request("PATCH", path, { body, expectedVersion: current[file]?.version });
      }
    }
    for (const t of scenario.threads) {
      const { thread } = await api.request<{ thread: Thread }>("POST", "/api/threads", {
        workspaceId: workspace.id,
        title: t.title,
        botIds: t.members.map((name) => receipt.bots[name]),
      });
      receipt.threads[t.key] = thread.id;
      await save(receipt);
    }
    receipt.state = "imported";
    await save(receipt);
    return receipt;
  } catch (error) {
    receipt.state = "failed";
    receipt.error = error instanceof Error ? error.message : "Import failed";
    await save(receipt);
    throw error;
  }
}

interface RunRecord extends Run {
  config?: unknown;
}
export interface TaskResult {
  name: string;
  status: "passed" | "completed-unchecked" | "failed" | "blocked" | "timeout" | "unknown";
  messageId?: string;
  error?: string;
  messages?: ThreadMessage[];
  runs?: { run: RunRecord; usage: unknown; events: unknown }[];
}
export interface ExecutionReport {
  scenarioHash: string;
  gateway: string;
  workspaceId: string;
  startedAt: string;
  gatewayConfig?: unknown;
  tasks: TaskResult[];
}
interface Runtime {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const runtime: Runtime = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Tasks are serial; a blocked/failed/unknown task prevents submission of subsequent tasks. */
export async function runScenario(
  api: Api,
  input: Scenario,
  receipt: ImportReceipt,
  save: Save,
  saveReport: (report: ExecutionReport) => Promise<void>,
  clock = runtime,
): Promise<ExecutionReport> {
  const scenario = parseScenario(input);
  check(
    receipt.state === "imported" && !receipt.execution && receipt.workspaceId,
    "Requires a complete, never-executed import receipt",
  );
  check(
    receipt.scenarioHash === fingerprint(scenario) && receipt.gateway === api.baseUrl,
    "Scenario hash or target Gateway differs from import receipt",
  );
  const workspaceId = receipt.workspaceId;
  const { workspace } = await api.request<{ workspace: Workspace }>(
    "GET",
    `/api/workspaces/${segment(workspaceId)}`,
  );
  for (const key of ["sandboxProvider", "egressAllowlist", "probe"] as const) {
    check(
      fingerprint(workspace[key] ?? null) === fingerprint(scenario.workspace[key] ?? null),
      `Workspace configuration changed: ${key}`,
    );
  }
  const { bots } = await api.request<{ bots: BotDefinition[] }>(
    "GET",
    `/api/bots?workspaceId=${segment(workspaceId)}`,
  );
  check(bots.length === scenario.bots.length, "Imported workspace membership changed");
  for (const spec of scenario.bots) {
    const bot = bots.find((b) => b.id === receipt.bots[spec.name] && b.name === spec.name);
    check(
      bot?.workspaceId === workspaceId && bot.cron.length === 0,
      "Bot mapping changed or schedules are enabled",
    );
    for (const key of [
      "role",
      "model",
      "cheapModel",
      "effort",
      "thinking",
      "connectors",
      "messageAllowlist",
    ] as const) {
      check(
        fingerprint(bot[key] ?? null) === fingerprint(spec[key] ?? null),
        `Bot configuration changed: ${spec.name}.${key}`,
      );
    }
    for (const [file, expected] of [
      ["soul", spec.soul],
      ["memory", spec.manualMemory ?? ""],
    ] as const) {
      const current = await api.request<Record<string, { body: string }>>(
        "GET",
        `/api/bots/${segment(bot.id)}/${file}`,
      );
      check(current[file]?.body === expected, `Bot ${file} changed since import`);
    }
  }
  for (const spec of scenario.threads) {
    const id = receipt.threads[spec.key];
    check(id, "Missing imported thread");
    const detail = await api.request<{ thread: Thread; members: { botId: string }[] }>(
      "GET",
      `/api/threads/${segment(id)}`,
    );
    check(
      detail.thread.workspaceId === workspaceId &&
        detail.thread.kind === "chat" &&
        JSON.stringify(detail.members.map((m) => m.botId)) ===
          JSON.stringify(spec.members.map((n) => receipt.bots[n])),
      "Thread mapping or member order changed",
    );
  }
  const readRuns = async (): Promise<RunRecord[]> => {
    const found = new Map<string, RunRecord>();
    for (const b of bots) {
      // A newest-first keyset page (#113 slice R): follow it to the end.
      let cursor: string | undefined;
      do {
        const page: { runs: RunRecord[]; nextCursor?: string } = await api.request(
          "GET",
          `/api/runs?botId=${segment(b.id)}&limit=100${cursor ? `&cursor=${segment(cursor)}` : ""}`,
        );
        for (const r of page.runs) found.set(r.id, r);
        cursor = page.nextCursor;
      } while (cursor);
    }
    return [...found.values()];
  };
  check((await readRuns()).length === 0, "Workspace already has runs; import a fresh scenario");
  const report: ExecutionReport = {
    scenarioHash: receipt.scenarioHash,
    gateway: api.baseUrl,
    workspaceId,
    startedAt: new Date().toISOString(),
    tasks: [],
  };
  report.gatewayConfig = await api.request("GET", "/api/config");
  await saveReport(report);
  // Durable reservation precedes every possible model-triggering write. Never auto-resume it.
  receipt.execution = "started";
  await save(receipt);
  try {
    for (const task of scenario.tasks) {
      const result: TaskResult = { name: task.name, status: "unknown" };
      report.tasks.push(result);
      await saveReport(report);
      const threadId = receipt.threads[task.thread] as string;
      const path = `/api/threads/${segment(threadId)}/messages`;
      const before = await api.request<{ messages: ThreadMessage[] }>("GET", path);
      const lastSeq = Math.max(0, ...before.messages.map((m) => m.seq));
      const existing = new Set((await readRuns()).map((r) => r.id));
      try {
        const { message } = await api.request<{ message: ThreadMessage }>("POST", path, {
          body: task.message,
        });
        result.messageId = message.id;
        await saveReport(report);
        const deadline = clock.now() + task.timeoutSeconds * 1000;
        let quietSince: number | undefined;
        let previous = "";
        let runs: RunRecord[] = [];
        while (clock.now() < deadline) {
          runs = (await readRuns()).filter((r) => !existing.has(r.id));
          const state = JSON.stringify(runs.map((r) => [r.id, r.status, r.attempt]).sort());
          if (state !== previous) {
            quietSince = clock.now();
            previous = state;
          }
          const quiet = quietSince !== undefined && clock.now() - quietSince >= 2000;
          if (runs.length && runs.every((r) => isTerminal(r.status)) && quiet) {
            result.status = runs.some((r) => !["succeeded", "silent"].includes(r.status))
              ? "failed"
              : "completed-unchecked";
            break;
          }
          if (
            quiet &&
            runs.some((r) => r.status.startsWith("waiting_")) &&
            runs.every(
              (r) =>
                isTerminal(r.status) || r.status === "queued" || r.status.startsWith("waiting_"),
            )
          ) {
            result.status = "blocked";
            break;
          }
          await clock.sleep(500);
        }
        if (result.status === "unknown") result.status = "timeout";
        const { messages } = await api.request<{ messages: ThreadMessage[] }>(
          "GET",
          `${path}?afterSeq=${lastSeq}`,
        );
        result.messages = messages;
        result.runs = [];
        for (const run of runs) {
          const detail = await api.request<{ run: RunRecord; usage: unknown[] }>(
            "GET",
            `/api/runs/${segment(run.id)}`,
          );
          // Every event, read as bounded tails (#113 slice R).
          const events: { seq: number }[] = [];
          for (let more = true; more; ) {
            const tail: { events: { seq: number }[]; hasMore?: boolean } = await api.request(
              "GET",
              `/api/runs/${segment(run.id)}/events?afterSeq=${events.at(-1)?.seq ?? 0}`,
            );
            events.push(...tail.events);
            more = tail.hasMore === true && tail.events.length > 0;
          }
          result.runs.push({
            run: detail.run,
            usage: detail.usage.length ? detail.usage : null,
            events,
          });
        }
        if (result.status === "completed-unchecked" && task.expectReply) {
          const expected = task.expectReply;
          result.status = messages.some(
            (m) =>
              m.authorKind === "bot" &&
              (!expected.bot || m.authorId === receipt.bots[expected.bot]) &&
              m.body.includes(expected.contains),
          )
            ? "passed"
            : "failed";
        }
      } catch (error) {
        result.status = "unknown";
        result.error = error instanceof Error ? error.message : "Execution error";
      }
      await saveReport(report);
      if (!["passed", "completed-unchecked"].includes(result.status)) break;
    }
  } finally {
    receipt.execution = "finished";
    await save(receipt);
  }
  return report;
}
