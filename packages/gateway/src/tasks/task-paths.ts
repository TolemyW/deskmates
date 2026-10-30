// Paths and evidence a run names in `task_deliver` and `task_checkpoint` (ADR-0021 A3g, A3h;
// issue #39 item 5). A relative path is resolved against the directory the run started in
// (ADR-0038: `/work/bots/<bot>` in per-bot mode, `/work` in shared mode) and `.`/`..` segments are
// normalised before ADR-0014's lexical policy is applied, so `web/app.py` names the bot's file and
// `../../../etc/passwd` is still refused. Checkpoint evidence may also be a commit hash or an
// http(s) URL; those are strings the bot attached, never fetched and never checked against a repo.
// This is a lexical convenience, not a boundary: the workspace's `file-read` still applies the
// full policy (realpath, no symlink escape) to every delivered file.
import {
  type BotWorkdirMode,
  type TaskEvidenceKind,
  WORKSPACE_FILE_PATH_CHARS,
  botWorkDir,
  workspaceFileRoot,
} from "@deskmates/contracts";

/** A short or full git object name; nothing checks it against a repository. */
const COMMIT = /^[0-9a-f]{7,40}$/i;
const URL_SCHEME = /^https?:\/\//i;

/** The directory a run starts in (ADR-0038 decision 1); a row without a mode ran in `/work`. */
export function runWorkDir(mode: BotWorkdirMode | undefined, botName: string): string {
  return mode === "per-bot" ? botWorkDir(botName) : "/work";
}

/**
 * `path` as an absolute, normalised path: relative to `workDir` unless it starts with `/`; empty
 * and `.` segments dropped, `..` removes the segment before it. Undefined when `..` climbs above
 * `/`. A trailing `/` is kept, so a directory stays visibly a directory for the policy.
 */
export function resolveRunPath(path: string, workDir: string): string | undefined {
  const joined = path.startsWith("/") ? path : `${workDir}/${path}`;
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}${path.endsWith("/") && out.length > 0 ? "/" : ""}`;
}

/** What a checkpoint evidence string is; a path is anything that is not a commit or a URL. */
export function evidenceKind(entry: string): TaskEvidenceKind {
  if (COMMIT.test(entry)) return "commit";
  if (URL_SCHEME.test(entry) && URL.canParse(entry)) return "url";
  return "path";
}

/** Where a run may name files, for errors and examples. */
export interface RunPathContext {
  workDir: string;
  botName: string;
  botNames: readonly string[];
}

export type PathCheck = { path: string } | { error: string };

/**
 * One path a run named, resolved and checked lexically. The error line names the path as given,
 * what it resolved to, why it was refused and where the bot may put the file instead.
 */
export function checkRunPath(raw: string, ctx: RunPathContext): PathCheck {
  const resolved = resolveRunPath(raw, ctx.workDir);
  const shown =
    resolved !== undefined && resolved !== raw ? `${raw} (resolved to ${resolved})` : raw;
  if (resolved !== undefined && workspaceFileRoot(resolved, ctx.botNames) !== undefined)
    return { path: resolved };
  const hint = `copy or write it under ${ctx.workDir}/ and name that path`;
  if (resolved === undefined) return { error: `${raw}: climbs above / with ..; ${hint}` };
  if (!WORKSPACE_FILE_PATH_CHARS.test(resolved))
    return {
      error: `${shown}: uses a character outside letters, digits, '.', '_', '-' and '/'; ${hint}`,
    };
  if (resolved.endsWith("/") || resolved === "/work" || resolved === `/home/${ctx.botName}`)
    return { error: `${shown}: names a directory; name a file inside it` };
  return {
    error: `${shown}: outside /work/ and /home/${ctx.botName}/ of this workspace; ${hint}`,
  };
}
