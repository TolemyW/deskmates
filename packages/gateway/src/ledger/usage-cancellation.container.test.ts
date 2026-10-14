// T2: a real isolated process is killed without a final SDK report. Synthetic receipts only;
// no model, workspace image, production volume or network is used.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { RunId } from "@deskmates/contracts";
import { expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { EventStore } from "./events.js";
import { usageReceipts } from "./usage-receipts.js";
const exec = promisify(execFile);
it("keeps durable measured usage after SIGKILL and Gateway database reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deskmates-usage72-"));
  const name = `deskmates-usage72-${randomUUID()}`;
  const file = join(dir, "ledger.sqlite");
  let db = openDatabase(file);
  try {
    db.prepare(
      "INSERT INTO workspaces(id, tenant_id,name,sandbox_provider,status,created_at) VALUES ('w', 'tnt_default','w','docker','ready','t')",
    ).run();
    db.prepare(
      "INSERT INTO bots(id,workspace_id,name,role,created_at) VALUES ('b','w','b','r','t')",
    ).run();
    db.prepare(
      "INSERT INTO runs(workspace_id, id,bot_id,lane,status,trigger_kind,trigger_ref,created_at,started_at) VALUES ('w', 'r','b','interactive','running','webhook','x','t','t')",
    ).run();
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network=none",
        "alpine:3.20",
        "sh",
        "-c",
        "printf '100\\n200\\n'; sleep 300",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    const events = new EventStore(db);
    let turn = 0;
    for await (const line of lines) {
      events.append({
        runId: "r" as RunId,
        kind: "turn_usage",
        attempt: 1,
        seq: ++turn,
        payload: {
          model: "synthetic",
          turn,
          inputTokens: Number(line),
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
        },
      });
      if (turn === 2) break;
    }
    expect(turn).toBe(2);
    await exec("docker", ["kill", "--signal=KILL", name]);
    await closed;
    db.prepare("UPDATE runs SET status='cancelled' WHERE id='r'").run();
    db.close();
    db = openDatabase(file);
    expect(usageReceipts(db, "r" as RunId)).toMatchObject({
      coverage: "partial",
      rows: [{ inputTokens: 300, outputTokens: null, costUsd: null }],
    });
  } finally {
    db.close();
    await exec("docker", ["rm", "-f", name]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
