// The takeover side of the Gateway's operator API, the way a human at the web UI drives it
// (design v0.3 §3.3, ADR-0004): take the workspace's browser, see that its screen is up, hand it
// back. Plus the one thing the API cannot do — the person's own action on the shared screen.
// The screen is reached through the Gateway's screen proxy only; no route returns the noVNC
// address or password (ADR-0022 amendment 1, C7).

import { readFileSync } from "node:fs";
import type { BotDefinition, BrowserLock, Workspace } from "@deskmates/contracts";
import type { StateView } from "@deskmates/golden-site";
import type { Stack } from "./start-stack.js";

/** `POST /api/workspaces/:id/takeover`: the lease the human now holds, and nothing else. */
export interface TakeoverResult {
  lock: BrowserLock;
}

/** `GET /api/workspaces/:id`: the workspace, its bots, who holds the browser, screen state. */
export interface WorkspaceView {
  workspace: Workspace;
  bots: BotDefinition[];
  browserLock: BrowserLock | null;
  takeoverScreen: boolean;
}

/**
 * Take the workspace browser over for a human. From here until `handBack` every browser tool call
 * in every run of the workspace is refused with `HUMAN_HOLDS_BROWSER_MESSAGE`, and the run's
 * ledger records a `takeover` event carrying that text.
 */
export async function takeOver(stack: Stack, authorId?: string): Promise<TakeoverResult> {
  const res = await stack.api<TakeoverResult>(
    "POST",
    `/api/workspaces/${stack.workspace.id}/takeover`,
    authorId === undefined ? {} : { authorId },
  );
  if (res.status !== 200) throw new Error(`takeover: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Release the human's lock; the parked bot's next browser call goes through again. */
export async function handBack(stack: Stack): Promise<{ released: true }> {
  const res = await stack.api<{ released: true }>(
    "POST",
    `/api/workspaces/${stack.workspace.id}/handback`,
  );
  if (res.status !== 200) throw new Error(`handback: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

export async function workspaceView(stack: Stack): Promise<WorkspaceView> {
  const res = await stack.api<WorkspaceView>("GET", `/api/workspaces/${stack.workspace.id}`);
  if (res.status !== 200)
    throw new Error(`get workspace: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Chromium's CDP endpoint inside the workspace container; never published to the host. */
const CDP_URL = "http://127.0.0.1:9222";
const SOLVE_SCRIPT_PATH = "/work/deskmates-human-solve.mjs";
const SOLVE_TIMEOUT_MS = 90_000;

/**
 * The human's own step: read the six-character code off the screen and type it into `/verify`.
 *
 * A test cannot drive a noVNC canvas, so this is done by a program instead — a short Playwright
 * script (`human-solve.mjs`) copied into the container and run there, attaching over CDP to the
 * very Chromium the noVNC screen is showing. That is the only part of the takeover that is
 * simulated: the lock, the refusal the bot's browser tools get, the screen and the hand back are
 * all the real thing, and the script types into the same shared browser a person would have.
 *
 * The code comes from the site's test surface (`/api/state`), because the page itself shows it
 * only as a picture; a person would read it with their eyes.
 *
 * Returns the URL the verification form landed on.
 */
export async function solveHumanCheck(stack: Stack): Promise<string> {
  const state = (await (await fetch(`${stack.siteUrl}/api/state`)).json()) as StateView;
  const code = state.humanCheck.code;
  if (!state.humanCheck.enabled || code.length === 0) {
    throw new Error("the golden site has no human verification step to solve");
  }

  const script = readFileSync(new URL("./human-solve.mjs", import.meta.url), "utf8");
  const wrote = await stack.provider.exec(stack.handle, {
    cmd: ["/bin/sh", "-c", 'cat > "$0"', SOLVE_SCRIPT_PATH],
    stdin: script,
    timeoutMs: 15_000,
  });
  if (wrote.exitCode !== 0) {
    throw new Error(`copying human-solve.mjs failed: ${wrote.stderr || wrote.stdout}`);
  }

  const run = await stack.provider.exec(stack.handle, {
    cmd: ["node", SOLVE_SCRIPT_PATH, code, CDP_URL, stack.siteOriginForBot],
    timeoutMs: SOLVE_TIMEOUT_MS,
  });
  if (run.exitCode !== 0) {
    throw new Error(
      `the human's verification script failed (exit ${run.exitCode}): ${run.stderr || run.stdout}`,
    );
  }
  const landed = /^RESULT (.+)$/m.exec(run.stdout);
  if (!landed?.[1]) throw new Error(`the human's script printed no result: ${run.stdout}`);
  return landed[1].trim();
}
