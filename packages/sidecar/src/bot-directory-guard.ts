// The bot-directory write guard (ADR-0038, owner-decided 2026-10-14). In a per-bot run another
// bot's directory `/work/bots/<name>` is read-only to this bot, and `/work/uploads` is read-only
// to every bot in every mode. The PreToolUse hook asks `botDirectoryRefusal` before anything else
// and denies the call with the returned message.
//
// THIS IS A GUARD AGAINST MISTAKES, NOT A SECURITY BOUNDARY. It reads the literal tool input: it
// does not follow symlinks, expand variables or globs, or see what a script, an interpreter
// (`python -c`, `node -e`), a build tool or a subprocess writes, nor a `cd` made by an earlier
// tool call. Every bot runs as the same Unix user with write permission everywhere. Anything that
// must not be writable by a bot belongs in a second workspace (ADR-0004 decision 5); OS-level
// isolation between bots is a later decision.

import { posix } from "node:path";
import { WORKSPACE_UPLOAD_ROOT, botWorkDir } from "@deskmates/contracts";
import { WORK_DIR } from "./risk-tier.js";
import { basename, shellArgvs, unwrapArgv } from "./shell-words.js";

const BOTS_ROOT = `${WORK_DIR}/bots`;

/** The file tools whose target is one path (ADR-0038 decision 2). */
const FILE_TOOL_PATH_KEYS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** Commands every one of whose path arguments is written, moved, removed or created. */
const WRITES_EVERY_PATH = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "touch",
  "mkdir",
  "tee",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
  "shred",
]);

/** Commands that write only their destination: `-t <dir>` or the last path argument. */
const WRITES_DESTINATION = new Set(["cp", "install", "ln", "rsync"]);

/** Commands that also destroy a protected directory when pointed at one of its ancestors. */
const RECURSIVE_DESTROYERS = new Set(["rm", "rmdir", "mv", "chmod", "chown", "chgrp"]);

/** Commands that write in place only with `-i` (`sed -i`, `perl -pi -e`). */
const IN_PLACE_EDITORS = new Set(["sed", "perl"]);

/** `git` subcommands that only read the repository. Anything else counts as a write. */
const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "annotate",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "grep",
  "describe",
  "shortlog",
  "cat-file",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "whatchanged",
  "count-objects",
  "help",
  "version",
]);

/** `git` subcommands whose path arguments are repositories they read from, not write to. */
const GIT_READS_FROM_PATH = new Set(["fetch", "pull", "remote", "submodule"]);

/** `git` global options that take a separate value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** `git clone` options that take a separate value, so the value is not taken for a path. */
const GIT_CLONE_VALUE_OPTIONS = new Set([
  "-b",
  "--branch",
  "-o",
  "--origin",
  "--depth",
  "-u",
  "--upload-pack",
  "--reference",
  "--separate-git-dir",
  "-c",
  "--config",
  "--filter",
  "-j",
  "--jobs",
  "--template",
  "--shallow-since",
  "--shallow-exclude",
]);

export type ProtectedArea = "teammate" | "uploads";

export interface BotDirectoryRefusal {
  /** The resolved path the call would have written. */
  path: string;
  area: ProtectedArea;
  /** The teammate whose directory it is, for `area: teammate`. */
  owner?: string;
  /** The deny reason the model reads. */
  message: string;
}

export interface GuardRun {
  botName: string;
  /** `per-bot` guards teammates' directories; any other mode guards uploads only. */
  workdirMode?: "per-bot";
  /** Where the run's shell and relative file paths start. */
  cwd: string;
}

/** A path as the guard sees it: absolute and normalized, or undefined when it cannot know. */
function resolvePath(word: string, cwd: string | undefined): string | undefined {
  // Variables, command substitutions, home shorthands and process substitutions are only known
  // at run time; a soft guard lets them through rather than guess.
  if (word === "" || /[$`]/.test(word) || word.startsWith("~") || word.startsWith("<(")) return;
  if (word.startsWith("/")) return posix.normalize(word);
  if (cwd === undefined) return;
  return posix.resolve(cwd, word);
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Which protected area `path` is in, for this run, if any. */
function areaOf(
  path: string,
  run: GuardRun,
): { area: ProtectedArea; owner?: string; root: string } | undefined {
  if (isWithin(path, WORKSPACE_UPLOAD_ROOT))
    return { area: "uploads", root: WORKSPACE_UPLOAD_ROOT };
  if (run.workdirMode !== "per-bot" || !path.startsWith(`${BOTS_ROOT}/`)) return;
  const owner = path.slice(BOTS_ROOT.length + 1).split("/")[0] ?? "";
  if (owner === "" || owner === run.botName) return;
  return { area: "teammate", owner, root: `${BOTS_ROOT}/${owner}` };
}

function refusal(path: string, run: GuardRun): BotDirectoryRefusal | undefined {
  const hit = areaOf(path, run);
  if (!hit) return;
  const own =
    run.workdirMode === "per-bot"
      ? `Write in your own directory, ${botWorkDir(run.botName)}, instead`
      : "Write somewhere else instead";
  const whose =
    hit.area === "uploads"
      ? `${hit.root} holds files people uploaded and is read-only to bots`
      : `${hit.root} is ${hit.owner}'s directory and is read-only to you`;
  return {
    path,
    area: hit.area,
    ...(hit.owner ? { owner: hit.owner } : {}),
    message: `bot_dirs_read_only: ${path} was not written. ${whose}. ${own}; to change a file from there, copy it into your directory first. You may still read it.`,
  };
}

/**
 * A recursive destroyer pointed at `/`, `/work` or `/work/bots` takes protected directories with
 * it. Uploads count in every mode, teammates' directories in per-bot mode.
 */
function ancestorRefusal(path: string, run: GuardRun): BotDirectoryRefusal | undefined {
  const perBot = run.workdirMode === "per-bot";
  const takes =
    path === "/" || path === WORK_DIR
      ? perBot
        ? "your teammates' directories and /work/uploads"
        : "/work/uploads"
      : path === BOTS_ROOT && perBot
        ? "your teammates' directories"
        : undefined;
  if (takes === undefined) return;
  const own = perBot ? ` Name paths inside your own directory, ${botWorkDir(run.botName)}.` : "";
  return {
    path,
    area: perBot && path !== "/" && path !== WORK_DIR ? "teammate" : "uploads",
    message: `bot_dirs_read_only: ${path} was not changed. It contains ${takes}, which are read-only to you.${own}`,
  };
}

/** The target of an output redirection word, or undefined when the word is not one. */
function redirectTarget(
  words: readonly string[],
  index: number,
): { target?: string; consumed: number } | undefined {
  const word = words[index] ?? "";
  // Unquoted words carry no whitespace; a quoted string with a `>` in it does, and is not one.
  if (/\s/.test(word)) return;
  const match = word.match(/^(?:[^>]*?)(?:\d*|&)(?:>>|>\||>)(.*)$/);
  if (!match) return;
  const rest = match[1] ?? "";
  if (rest.startsWith("&")) return { consumed: 0 }; // `2>&1`: a file descriptor, not a path
  if (rest !== "") return { target: rest, consumed: 0 };
  const next = words[index + 1];
  return next === undefined ? { consumed: 0 } : { target: next, consumed: 1 };
}

/** Positional words of a command after its name, options dropped. */
function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") continue;
    out.push(arg);
  }
  return out;
}

/** What one simple command (already unwrapped) would write, as words to resolve. */
function commandWrites(
  argv: readonly string[],
  cwd: string | undefined,
): { cwd: string | undefined; words: string[]; ancestors: string[] } {
  const name = basename(argv[0] ?? "");
  const args = argv.slice(1);
  const words: string[] = [];
  const ancestors: string[] = [];

  if (WRITES_EVERY_PATH.has(name)) {
    const paths = positionals(args);
    words.push(...paths);
    if (RECURSIVE_DESTROYERS.has(name)) ancestors.push(...paths);
  } else if (WRITES_DESTINATION.has(name)) {
    const target = args.findIndex((a) => a === "-t" || a.startsWith("--target-directory"));
    if (target !== -1) {
      const option = args[target] ?? "";
      const value = option.includes("=") ? option.slice(option.indexOf("=") + 1) : args[target + 1];
      if (value !== undefined) words.push(value);
    } else {
      const paths = positionals(args).filter((p) => !/^[^/]*:/.test(p)); // rsync host:path
      if (paths.length >= 2) words.push(paths.at(-1) ?? "");
    }
  } else if (IN_PLACE_EDITORS.has(name)) {
    if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")))
      words.push(...positionals(args));
  } else if (name === "dd") {
    for (const arg of args) if (arg.startsWith("of=")) words.push(arg.slice(3));
  } else if (name === "git") {
    return { cwd, ...gitWrites(args, cwd), ancestors };
  }
  return { cwd, words, ancestors };
}

/** `git`: where it acts and what it writes, unless the subcommand only reads. */
function gitWrites(args: readonly string[], cwd: string | undefined): { words: string[] } {
  let dir = cwd;
  const extra: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) break;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    if (GIT_VALUE_OPTIONS.has(flag)) {
      const value = inline ?? args[++i];
      if (value === undefined) continue;
      if (flag === "-C") dir = resolvePath(value, dir);
      else if (flag === "--git-dir" || flag === "--work-tree") {
        const path = resolvePath(value, dir);
        if (path !== undefined) extra.push(path);
      }
    }
  }
  const sub = args[i] ?? "";
  const rest = args.slice(i + 1);
  if (sub === "" || GIT_READ_ONLY.has(sub)) return { words: [] };
  // These read from a repository named by path and write only where they run.
  if (GIT_READS_FROM_PATH.has(sub))
    return { words: [...(dir === undefined ? [] : [dir]), ...extra] };
  if (sub === "clone") {
    const paths: string[] = [];
    for (let j = 0; j < rest.length; j++) {
      const arg = rest[j] ?? "";
      if (GIT_CLONE_VALUE_OPTIONS.has(arg)) j++;
      else if (!arg.startsWith("-")) paths.push(arg);
    }
    const repo = paths[0];
    const destination =
      paths[1] ??
      (repo === undefined
        ? undefined
        : posix.basename(repo.replace(/\/+$/, "")).replace(/\.git$/, ""));
    return {
      words:
        destination === undefined || dir === undefined ? [] : [posix.resolve(dir, destination)],
    };
  }
  // The repository it acts in, plus any absolute or `..` path argument (a branch name such as
  // `bots/nova` is neither, so it is not mistaken for a path).
  const explicit = rest.filter(
    (a) => !a.startsWith("-") && (a.startsWith("/") || a.split("/").includes("..")),
  );
  return {
    words: [
      ...(dir === undefined ? [] : [dir]),
      ...extra,
      ...explicit.map((a) => (dir ? posix.resolve(dir, a) : a)),
    ],
  };
}

/**
 * ADR-0038 decisions 2 and 3: why the shell command would write into a protected directory, or
 * undefined. A `cd` earlier in the same command moves the directory relative paths resolve
 * against; a `cd` in an earlier tool call is not seen.
 */
export function shellRefusal(command: string, run: GuardRun): BotDirectoryRefusal | undefined {
  let cwd: string | undefined = run.cwd;
  for (const raw of shellArgvs(command)) {
    // Redirections are written by the shell whatever the command is.
    const argv: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const redirect = redirectTarget(raw, i);
      if (redirect === undefined) {
        argv.push(raw[i] ?? "");
        continue;
      }
      if (redirect.target !== undefined) {
        const path = resolvePath(redirect.target, cwd);
        const hit = path === undefined ? undefined : refusal(path, run);
        if (hit) return hit;
      }
      i += redirect.consumed;
    }
    const command = unwrapArgv(argv);
    const name = basename(command[0] ?? "");
    if (name === "cd" || name === "pushd") {
      const target = positionals(command.slice(1))[0];
      cwd = target === undefined ? undefined : resolvePath(target, cwd);
      continue;
    }
    const writes = commandWrites(command, cwd);
    for (const word of writes.words) {
      const path = resolvePath(word, cwd);
      const hit = path === undefined ? undefined : refusal(path, run);
      if (hit) return hit;
    }
    for (const word of writes.ancestors) {
      const path = resolvePath(word, cwd);
      const hit = path === undefined ? undefined : ancestorRefusal(path, run);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * The guard the hook calls for every tool call: a file tool's target, or a shell command's
 * obvious writes. Undefined lets the call go on to the usual checks.
 */
export function botDirectoryRefusal(
  toolName: string,
  input: Record<string, unknown>,
  command: string,
  isShell: boolean,
  run: GuardRun,
): BotDirectoryRefusal | undefined {
  const key = FILE_TOOL_PATH_KEYS[toolName];
  if (key !== undefined) {
    const value = input[key];
    if (typeof value !== "string") return;
    const path = resolvePath(value, run.cwd);
    return path === undefined ? undefined : refusal(path, run);
  }
  if (isShell && command !== "") return shellRefusal(command, run);
  return undefined;
}
