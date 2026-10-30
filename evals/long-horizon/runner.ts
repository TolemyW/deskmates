// Opt-in real-stack executor. Imported only by the explicitly enabled acceptance suite.
import { isTerminal } from "@deskmates/contracts";
import type { OpLogEntry, StateView } from "@deskmates/golden-site";
import { decideApproval, pendingApprovals } from "../../acceptance/support/approvals.js";
import { restartGateway } from "../../acceptance/support/restart-gateway.js";
import { type RunView, getRun, postMessage, runsForBot } from "../../acceptance/support/runs.js";
import type { Stack } from "../../acceptance/support/start-stack.js";
import { MissionRunAccounting } from "./accounting.js";
import { matchesFixtureApproval } from "./approval.js";
import { type CheckResult, grade, mutations } from "./grade.js";
import { type Mission, type Phase, remainingMs, verdict } from "./mission.js";
import { observeDeployment } from "./observer.js";
import { type MissionReport, type PhaseReport, digest } from "./report.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function boundedStack(stack: Stack, deadline: number): Stack {
  return {
    ...stack,
    // Access the current app after a restart; the helper's api closure uses the same port.
    api: async (method, path, body, options) => {
      const ms = remainingMs(deadline, Date.now(), 10_000);
      if (ms <= 0) throw new Error("mission_deadline");
      return stack.api(method, path, body, {
        signal: options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(ms)])
          : AbortSignal.timeout(ms),
      });
    },
  };
}

async function siteRead<T>(stack: Stack, suffix: string, deadline: number): Promise<T> {
  const ms = remainingMs(deadline, Date.now(), 10_000);
  if (!ms) throw new Error("mission_deadline");
  const res = await fetch(`${stack.siteUrl}/api/state${suffix}`, {
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`site observer: ${res.status}`);
  return (await res.json()) as T;
}

async function waitPhase(
  stack: Stack,
  run: RunView,
  phase: Phase,
  deadline: number,
): Promise<CheckResult[]> {
  let decided = false;
  let decidedAtAttempt = 0;
  const checks: CheckResult[] = [];
  for (;;) {
    if (!remainingMs(deadline)) throw new Error("mission_deadline");
    const current = (await getRun(stack, run.id)).run;
    if (isTerminal(current.status)) {
      if (phase.approval && !decided)
        checks.push({ name: "declared fixture approval reached", status: "fail" });
      return checks;
    }
    if (current.status === "waiting_approval") {
      const pending = (await pendingApprovals(stack)).filter((a) => a.runId === run.id);
      const approval = pending[0];
      // The decision response can precede the scheduler's queued/running transition. The old
      // parked row with no pending request is not a second approval or another model attempt.
      if (decided && current.attempt <= decidedAtAttempt && pending.length === 0) {
        await sleep(remainingMs(deadline, Date.now(), 200));
        continue;
      }
      if (
        decided ||
        pending.length !== 1 ||
        !approval ||
        !matchesFixtureApproval(approval, phase, stack.siteOriginForBot, run.id)
      ) {
        throw new Error("unmatched_or_repeated_approval");
      }
      const hold = (phase.approval?.holdSeconds ?? 0) * 1000;
      if (remainingMs(deadline) <= hold) throw new Error("mission_deadline");
      await sleep(hold);
      // Decision applies to this audited id only, never an Always rule or another task message.
      await decideApproval(stack, approval.id, phase.approval?.decision ?? "deny");
      decided = true;
      decidedAtAttempt = current.attempt;
      checks.push({
        name: "declared fixture approval reached",
        status: "pass",
        observed: {
          approvalId: approval.id,
          inputSha256: digest(JSON.stringify(approval.action.input)),
        },
      });
    }
    await sleep(remainingMs(deadline, Date.now(), 200));
  }
}

async function sampleResources(stack: Stack): Promise<MissionReport["resources"][number]> {
  const at = new Date().toISOString();
  try {
    const response = await stack.docker.client.request(
      "GET",
      `/containers/${stack.handle.providerRef}/stats?stream=false`,
      undefined,
      { timeoutMs: 5000 },
    );
    if (response.status !== 200) throw new Error(`resource observer: ${response.status}`);
    const stats = JSON.parse(response.body) as {
      memory_stats?: { usage?: number; stats?: { inactive_file?: number } };
      cpu_stats?: {
        cpu_usage?: { total_usage?: number };
        system_cpu_usage?: number;
        online_cpus?: number;
      };
      precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
    };
    const memory = stats.memory_stats;
    const c = stats.cpu_stats;
    const p = stats.precpu_stats;
    const systemDelta =
      c?.system_cpu_usage !== undefined && p?.system_cpu_usage !== undefined
        ? c.system_cpu_usage - p.system_cpu_usage
        : null;
    const cpuDelta =
      c?.cpu_usage?.total_usage !== undefined && p?.cpu_usage?.total_usage !== undefined
        ? c.cpu_usage.total_usage - p.cpu_usage.total_usage
        : null;
    return {
      at,
      memBytes:
        memory?.usage === undefined
          ? null
          : Math.max(0, memory.usage - (memory.stats?.inactive_file ?? 0)),
      cpuPct:
        systemDelta !== null && systemDelta > 0 && cpuDelta !== null && c?.online_cpus !== undefined
          ? (cpuDelta / systemDelta) * c.online_cpus * 100
          : null,
    };
  } catch (error) {
    return { at, memBytes: null, cpuPct: null, error: String(error) };
  }
}

export async function runMission(input: {
  mission: Mission;
  specText: string;
  stack: Stack;
  repeat: number;
  arm: string;
  imageId: string;
  egressImageId: string;
  persist: (report: MissionReport) => void;
}): Promise<MissionReport> {
  const { mission, stack } = input;
  const t0 = Date.now();
  const deadline = t0 + mission.budgets.missionWallSeconds * 1000;
  const accounting = new MissionRunAccounting();
  const report: MissionReport = {
    schemaVersion: 2,
    workspaceId: stack.workspace.id,
    missionId: mission.id,
    specSha256: digest(input.specText),
    repeat: input.repeat,
    arm: input.arm,
    startedAt: new Date(t0).toISOString(),
    finishedAt: null,
    config: {
      workspaceImageId: input.imageId,
      egressProxyImageId: input.egressImageId,
      defaultModel: stack.config.defaultModel,
      cheapModel: stack.config.cheapModel,
    },
    outcome: "unknown",
    termination: "in_progress",
    phases: [],
    final: [],
    runs: [],
    totals: accounting.totals([]),
    observerErrors: [],
    injections: [],
    resources: [],
    site: {},
    progressCurve: [],
  };
  const persist = () => {
    report.totals = accounting.totals(
      report.runs,
      report.phases.flatMap((p) => (p.runId ? [p.runId] : [])),
    );
    input.persist(report);
  };
  persist();
  stack.config.maxTurns = mission.budgets.maxTurns;
  stack.config.runTimeoutSeconds = mission.budgets.runTimeoutSeconds;
  stack.config.strategyEvidence = { missionId: mission.id, specSha256: report.specSha256 };
  const cancelOwned = () => {
    // Only runs in the exact isolated workspace created for this mission, including jobs.
    for (const run of stack.app.deskmates.ctx.runs.list())
      if (
        stack.app.deskmates.ctx.bots.get(run.botId)?.workspaceId === stack.workspace.id &&
        !isTerminal(run.status)
      )
        stack.app.deskmates.scheduler.cancel(run.id, "test");
  };
  const timer = setTimeout(cancelOwned, mission.budgets.missionWallSeconds * 1000);
  let sampling: Promise<void> = Promise.resolve();
  let samplingBusy = false;
  const sample = () => {
    if (samplingBusy) return;
    samplingBusy = true;
    sampling = sampleResources(stack)
      .then((reading) => {
        report.resources.push(reading);
      })
      .finally(() => {
        samplingBusy = false;
      });
  };
  const resourceTimer = setInterval(sample, 30_000);
  sample();
  let blocked = false;
  const observed = async <T>(
    source: string,
    phase: string,
    f: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await f();
    } catch (error) {
      report.observerErrors.push({ phase, source, error: String(error) });
      return undefined;
    }
  };
  const capture = async (phase: string) => {
    const snapshot = await observed("deployment", phase, () =>
      observeDeployment(stack, stack.workspace.id),
    );
    accounting.capture(snapshot);
    if (snapshot) {
      report.runs = [
        ...new Map([...report.runs, ...snapshot.runs].map((r) => [r.runId, r])).values(),
      ];
      for (const err of snapshot.errors)
        report.observerErrors.push({ phase, source: err.runId, error: err.error });
      if (snapshot.inventoryError)
        report.observerErrors.push({
          phase,
          source: "run_inventory",
          error: snapshot.inventoryError,
        });
    }
  };
  try {
    const mode = await stack.api(
      "PUT",
      `/api/workspaces/${stack.workspace.id}/auto-approval`,
      { mode: "manual" },
      { signal: AbortSignal.timeout(10_000) },
    );
    if (mode.status !== 200) throw new Error("cannot set mission fixture approvals to manual");
    report.site.seed = await observed("seed", "setup", () =>
      siteRead<StateView>(stack, "", deadline),
    );
    if (!report.site.seed) blocked = true;
    for (const phase of mission.phases) {
      const p: PhaseReport = {
        id: phase.id,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "running",
        checks: [],
      };
      report.phases.push(p);
      persist();
      if (blocked || !remainingMs(deadline)) {
        p.status = "not_reached";
        p.finishedAt = new Date().toISOString();
        persist();
        continue;
      }
      const phaseDeadline = Math.min(
        deadline,
        Date.now() + (mission.budgets.runTimeoutSeconds + 60) * 1000,
      );
      const bounded = boundedStack(stack, phaseDeadline);
      const phaseLog = await observed("phase_log_before", phase.id, () =>
        siteRead<OpLogEntry[]>(stack, "/log", phaseDeadline),
      );
      try {
        if (phase.inject) {
          const injection: MissionReport["injections"][number] = {
            phase: phase.id,
            kind: phase.inject,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            ok: false,
          };
          report.injections.push(injection);
          persist();
          await restartGateway(stack);
          const ready = await bounded.api("GET", `/api/workspaces/${stack.workspace.id}`);
          if (ready.status !== 200) throw new Error("restarted Gateway not ready");
          injection.ok = true;
          injection.finishedAt = new Date().toISOString();
          p.checks.push({
            name: "Gateway restarted on the same database and port",
            status: "pass",
          });
        } else if (phase.trigger?.kind === "message") {
          const started = await postMessage(bounded, phase.trigger.text);
          p.runId = started.run.id;
          persist();
          p.checks.push(...(await waitPhase(bounded, started.run, phase, phaseDeadline)));
        } else if (phase.trigger?.kind === "cron") {
          const known = new Set((await runsForBot(bounded)).map((r) => r.id));
          stack.app.deskmates.cron.tick(new Date(phase.trigger.at));
          let run: RunView | undefined;
          while (!run) {
            if (!remainingMs(phaseDeadline)) throw new Error("mission_deadline");
            run = (await runsForBot(bounded)).find(
              (r) => r.triggerKind === "cron" && !known.has(r.id),
            );
            if (!run) await sleep(remainingMs(phaseDeadline, Date.now(), 200));
          }
          p.runId = run.id;
          persist();
          p.checks.push(...(await waitPhase(bounded, run, phase, phaseDeadline)));
        }
      } catch (error) {
        p.error = String(error);
        blocked = true;
        cancelOwned();
        p.checks.push({ name: "phase execution completed", status: "unknown", observed: p.error });
      }
      // A bounded post-stop grace observes partial outcomes even after the mission deadline.
      const observationDeadline = Math.max(Date.now() + 10_000, deadline);
      report.site.after = await observed("state", phase.id, () =>
        siteRead<StateView>(stack, "", observationDeadline),
      );
      report.site.log = await observed("operation_log", phase.id, () =>
        siteRead<OpLogEntry[]>(stack, "/log", observationDeadline),
      );
      await capture(phase.id);
      const files: Record<string, string | null | undefined> = {};
      for (const oracle of phase.checkpoints)
        if (oracle.type === "file_regex_count") {
          files[oracle.path] = await observed("file", phase.id, async () => {
            const file = await stack.provider.exec(stack.handle, {
              cmd: ["cat", oracle.path],
              timeoutMs: 5000,
            });
            return file.exitCode === 0 ? file.stdout : null;
          });
        }
      const run = report.runs.find((r) => r.runId === p.runId);
      for (const oracle of phase.checkpoints)
        p.checks.push(
          grade(oracle, {
            mission,
            asOf: report.startedAt,
            ...(report.site.seed ? { seed: report.site.seed } : {}),
            ...(report.site.after ? { after: report.site.after } : {}),
            ...(report.site.log && phaseLog ? { log: report.site.log } : {}),
            phaseLogStart: phaseLog?.length ?? 0,
            ...(run ? { run } : {}),
            files,
          }),
        );
      sample();
      p.status = verdict(p.checks);
      p.finishedAt = new Date().toISOString();
      persist();
      if (!report.totals.inventoryComplete || report.totals.unknownUsageRuns > 0) blocked = true;
    }
    const finalFiles: Record<string, string | null | undefined> = {};
    for (const oracle of mission.final)
      if (oracle.type === "file_regex_count") {
        finalFiles[oracle.path] = await observed("file", "final", async () => {
          const file = await stack.provider.exec(stack.handle, {
            cmd: ["cat", oracle.path],
            timeoutMs: 5000,
          });
          return file.exitCode === 0 ? file.stdout : null;
        });
      }
    for (const oracle of mission.final)
      report.final.push(
        grade(oracle, {
          mission,
          asOf: report.startedAt,
          ...(report.site.seed ? { seed: report.site.seed } : {}),
          ...(report.site.after ? { after: report.site.after } : {}),
          ...(report.site.log ? { log: report.site.log } : {}),
          phaseLogStart: 0,
          files: finalFiles,
        }),
      );
    report.progressCurve = mutations(report.site.log ?? []).map((e) => ({
      atMs: Date.parse(e.ts) - t0,
      op: e.op,
      id: e.details.id ?? null,
    }));
    const checks = [...report.phases.flatMap((p) => p.checks), ...report.final];
    report.outcome =
      report.observerErrors.length || report.phases.some((p) => p.status === "not_reached")
        ? "unknown"
        : verdict(checks);
    report.termination = !remainingMs(deadline)
      ? "mission_deadline"
      : blocked
        ? "stopped_after_unresolved_phase_or_usage"
        : report.outcome === "pass"
          ? "verified_success"
          : "oracle_result";
  } catch (error) {
    report.termination = "harness_error";
    report.observerErrors.push({ phase: "mission", source: "runner", error: String(error) });
    report.outcome = "unknown";
  } finally {
    clearTimeout(timer);
    clearInterval(resourceTimer);
    await sampling;
    cancelOwned();
    await capture("final");
    if (
      report.observerErrors.length ||
      report.runs.some((r) => !isTerminal(r.status as import("@deskmates/contracts").RunStatus))
    )
      report.outcome = "unknown";
    report.finishedAt = new Date().toISOString();
    persist();
  }
  return report;
}
