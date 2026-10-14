// Tear the stack down in the order that cannot hang: destroy the containers first (the stack's
// own and every one `addWorkspace` added; any sidecar exec still attached ends with its container
// and the scheduler marks its run failed), drain the scheduler, close the Gateway and the golden
// site, remove every workspace's named volumes and the temp database directory. Every step is
// best-effort so one failure does not leak the rest — a leaked extra workspace is a 4 GiB
// container left running per campaign.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { backupTestLedger } from "./ledger-backup.js";
import type { Stack } from "./start-stack.js";

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

export async function stopStack(stack: Stack | undefined): Promise<void> {
  if (!stack) return;
  // `?? []`: T0 tests hand in partial stacks cast to Stack.
  const extras = stack.extraWorkspaces ?? [];
  // A real teardown warns on stderr: a leaked container must not be silent. A test that injects
  // failures on purpose collects them through `onStopProblem`, so only a real problem is printed.
  const report = stack.onStopProblem ?? ((message: string) => console.warn(message));
  // In parallel: each destroy waits on its own Chromium's SIGTERM, and each is best-effort.
  await Promise.all([
    attempt(report, "destroy container", () => stack.docker.destroy(stack.handle)),
    ...extras.map((extra) =>
      attempt(report, `destroy container of ${extra.workspace.id}`, () =>
        stack.docker.destroy(extra.handle),
      ),
    ),
  ]);
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
  for (const volume of [...stack.volumes, ...extras.flatMap((extra) => extra.volumes)]) {
    await attempt(report, `remove volume ${volume}`, async () => {
      const res = await stack.docker.client.request("DELETE", `/volumes/${volume}?force=true`);
      if (res.status !== 204 && res.status !== 404) throw new Error(`status ${res.status}`);
    });
  }
  await attempt(report, "remove temp dir", async () => {
    rmSync(stack.tmpDir, { recursive: true, force: true });
  });
}
