// `deskmates-sidecar bot-rename`: move a renamed bot's home and working directory (ADR-0043
// decision 1). The Gateway runs this fixed command with `{from, to}` on stdin, holds the bot's
// runs while it runs, and commits the new name only after it succeeded. Every check happens
// before the first move, so a refusal moves nothing; a failure on the second move puts the first
// back. A directory of the new name that is empty is replaced; one that holds files refuses.

import { existsSync, lstatSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";

const BOT_NAME = /^[A-Za-z0-9_-]+$/;

export interface BotRenameRoots {
  /** `/home` in the container: one directory per bot. */
  homes: string;
  /** `/work/bots` in the container: each bot's working directory (ADR-0038). */
  workdirs: string;
}

export const BOT_RENAME_ROOTS: BotRenameRoots = { homes: "/home", workdirs: "/work/bots" };

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function renameBotDirectories(roots: BotRenameRoots, input: unknown): { moved: string[] } {
  const request = input as { from?: unknown; to?: unknown } | null;
  if (
    !request ||
    typeof request.from !== "string" ||
    typeof request.to !== "string" ||
    !BOT_NAME.test(request.from) ||
    !BOT_NAME.test(request.to) ||
    request.from === request.to
  )
    throw new Error("Invalid bot rename request");
  const plans: { from: string; to: string; replaceEmpty: boolean }[] = [];
  for (const root of [roots.homes, roots.workdirs]) {
    const from = join(root, request.from);
    const to = join(root, request.to);
    if (!present(from)) continue;
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${from} is not a plain directory; move it by hand`);
    let replaceEmpty = false;
    if (present(to)) {
      const target = lstatSync(to);
      if (target.isSymbolicLink() || !target.isDirectory() || readdirSync(to).length > 0)
        throw new Error(`${to} already exists and is not empty; move or remove it first`);
      replaceEmpty = true;
    }
    plans.push({ from, to, replaceEmpty });
  }
  const moved: string[] = [];
  try {
    for (const plan of plans) {
      if (plan.replaceEmpty) rmdirSync(plan.to);
      renameSync(plan.from, plan.to);
      moved.push(plan.to);
    }
  } catch (err) {
    for (const plan of plans.filter((p) => moved.includes(p.to)).reverse()) {
      if (existsSync(plan.to) && !present(plan.from)) renameSync(plan.to, plan.from);
    }
    throw err;
  }
  return { moved };
}
