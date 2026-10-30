// Tear the stack down in the order that cannot hang: destroy the containers first (the stack's
// own and every one `addWorkspace` added; any sidecar exec still attached ends with its container
// and the scheduler marks its run failed), drain the scheduler, close the Gateway and the golden
// site, remove every workspace's named volumes, then everything still labelled with a workspace
// the stack created (ADR-0006 amendment 5 decision 15), and the temp database directory. Every
// step is best-effort so one failure does not leak the rest — a leaked extra workspace is a 4 GiB
// container left running per campaign. `DESKMATES_T2_KEEP_WORKSPACE=1` keeps the workspaces
// (containers, proxies, networks, volumes) for inspection and prints what it kept.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { DockerProvider } from "@deskmates/sandbox-docker";
import { backupTestLedger } from "./ledger-backup.js";
import type { Stack } from "./start-stack.js";

/** Set to `1` to keep the workspaces a stack created, failed or not, for inspection. */
export const KEEP_WORKSPACE_ENV = "DESKMATES_T2_KEEP_WORKSPACE";

export function keepWorkspaces(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KEEP_WORKSPACE_ENV]?.trim() === "1";
}

/** What `startStack` had made when it failed; `abandonStart` takes exactly that down. */
export interface StartedParts {
  docker?: Pick<DockerProvider, "removeHostResources">;
  app?: { close(): Promise<unknown> };
  site?: { close(): Promise<unknown> };
  tmpDir?: string;
  workspaceIds: string[];
}

async function attempt(
  report: (message: string) => void,
  what: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    report(`[acceptance] stop-stack: ${what} failed: ${String(err)}`);
  }
}

/**
 * Remove every managed resource labelled with each workspace id (containers, then networks,
 * then volumes), or with the keep flag, say what is kept and remove nothing.
 */
export async function removeStackWorkspaces(
  docker: Pick<DockerProvider, "removeHostResources">,
  workspaceIds: readonly string[],
  report: (message: string) => void,
): Promise<void> {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return;
  if (keepWorkspaces()) {
    report(
      `[acceptance] ${KEEP_WORKSPACE_ENV}=1: kept workspace ${ids.join(", ")}; remove it with \`docker ps -a --filter label=deskmates.workspace=<id>\` and the Network page's Host resources`,
    );
    return;
  }
  for (const workspaceId of ids)
    await attempt(report, `remove resources of ${workspaceId}`, async () => {
      await docker.removeHostResources({ kind: "workspace", workspaceId, keepVolumes: false });
    });
}

/** A failed `startStack`: close what it opened and remove the workspace it created. */
export async function abandonStart(
  parts: StartedParts,
  report: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  const { app, site, docker, tmpDir } = parts;
  if (app) await attempt(report, "close gateway", () => app.close().then(() => undefined));
  if (site) await attempt(report, "close golden site", () => site.close().then(() => undefined));
  if (docker) await removeStackWorkspaces(docker, parts.workspaceIds, report);
  if (tmpDir)
    await attempt(report, "remove temp dir", async () => {
      rmSync(tmpDir, { recursive: true, force: true });
    });
}

export async function stopStack(stack: Stack | undefined): Promise<void> {
  if (!stack) return;
  // `?? []`: T0 tests hand in partial stacks cast to Stack.
  const extras = stack.extraWorkspaces ?? [];
  // A real teardown warns on stderr: a leaked container must not be silent. A test that injects
  // failures on purpose collects them through `onStopProblem`, so only a real problem is printed.
  const report = stack.onStopProblem ?? ((message: string) => console.warn(message));
  const created = [
    ...(stack.createdWorkspaceIds ?? []),
    ...(stack.workspace ? [stack.workspace.id] : []),
    ...extras.map((extra) => extra.workspace.id),
  ];
  const keep = keepWorkspaces();
  // In parallel: each destroy waits on its own Chromium's SIGTERM, and each is best-effort.
  await Promise.all(
    keep
      ? []
      : [
          attempt(report, "destroy container", () => stack.docker.destroy(stack.handle)),
          ...extras.map((extra) =>
            attempt(report, `destroy container of ${extra.workspace.id}`, () =>
              stack.docker.destroy(extra.handle),
            ),
          ),
        ],
  );
  await attempt(report, "drain scheduler", () => stack.app.deskmates.scheduler.drain());
  const ledgerDir = process.env.DESKMATES_QA_LEDGER_DIR;
  if (ledgerDir) {
    await attempt(report, "preserve QA ledger", async () => {
      mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
      const target = join(ledgerDir, `ledger-${randomUUID()}.sqlite`);
      const receipt = await backupTestLedger(stack.app.deskmates.ctx.db, stack.dbPath, target);
      appendFileSync(
        join(ledgerDir, "ledger-backup-status.jsonl"),
        `${JSON.stringify({ ...receipt, workspaceId: stack.workspace.id, target: basename(target) })}\n`,
        { mode: 0o600 },
      );
      if (receipt.status !== "saved") {
        report(`[acceptance] QA ledger unavailable: ${receipt.reason}`);
      }
    });
  }
  await attempt(report, "close gateway", () => stack.app.close());
  await attempt(report, "close golden site", () => stack.site.close());
  for (const volume of keep
    ? []
    : [...stack.volumes, ...extras.flatMap((extra) => extra.volumes)]) {
    await attempt(report, `remove volume ${volume}`, async () => {
      const res = await stack.docker.client.request("DELETE", `/volumes/${volume}?force=true`);
      if (res.status !== 204 && res.status !== 404) throw new Error(`status ${res.status}`);
    });
  }
  // Whatever the steps above did not reach (a container a restart replaced, a network, a volume
  // of a failed `addWorkspace`) goes by its labels.
  await removeStackWorkspaces(stack.docker, created, report);
  await attempt(report, "remove temp dir", async () => {
    rmSync(stack.tmpDir, { recursive: true, force: true });
  });
}
