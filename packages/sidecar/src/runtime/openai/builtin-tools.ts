// The file and shell tools the OpenAI runtime offers (ADR-0042 decision 4). The Claude Agent SDK
// has these built in; the OpenAI Agents SDK has none, so the sidecar provides them under the same
// names and parameter names (`file_path`, `content`, `old_string`, `new_string`, `command`,
// `pattern`, `path`), which is what keeps the tier tables, the bot-directory guard and the
// handoff's written-file list valid on both runtimes. Outputs are bounded: a tool result is model
// context, not a file transfer.

import { spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolOutcome, ToolSpec } from "./types.js";

/** Longest tool result handed to the model, in characters. */
export const BUILTIN_OUTPUT_MAX_CHARS = 30_000;
/** Default and ceiling of a shell command's wall clock, in milliseconds. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
const READ_DEFAULT_LIMIT = 2000;
const SEARCH_MAX_FILES = 5000;
const SEARCH_MAX_MATCHES = 200;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

function truncate(text: string, max = BUILTIN_OUTPUT_MAX_CHARS): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

function int(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

function fail(text: string): ToolOutcome {
  return { text, isError: true };
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** A glob with `**`, `*` and `?`, matched against a slash-separated relative path. */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        out += "(?:.*/)?";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`${out}$`);
}

async function walk(root: string, onFile: (path: string) => Promise<boolean>): Promise<void> {
  const queue = [root];
  let seen = 0;
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (seen > SEARCH_MAX_FILES || !(await onFile(full))) return;
    }
  }
}

export function builtinTools(cwd: string): ToolSpec[] {
  return [
    {
      name: "Read",
      description:
        "Read a text file. Returns the lines with line numbers, like `cat -n`. `offset` and `limit` select a range of lines.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path, or relative to the working directory.",
          },
          offset: { type: "integer", description: "First line to return, 1-based." },
          limit: { type: "integer", description: "How many lines to return." },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
      async run(input) {
        const path = str(input, "file_path");
        if (!path) return fail("file_path is required");
        let text: string;
        try {
          text = await readFile(resolvePath(cwd, path), "utf8");
        } catch (err) {
          return fail(`cannot read ${path}: ${String(err)}`);
        }
        const lines = text.split("\n");
        const start = Math.max(1, int(input, "offset") ?? 1);
        const count = Math.max(1, int(input, "limit") ?? READ_DEFAULT_LIMIT);
        const slice = lines.slice(start - 1, start - 1 + count);
        const width = String(start + slice.length).length;
        return {
          text: truncate(
            slice.map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join("\n"),
          ),
        };
      },
    },
    {
      name: "Write",
      description: "Write a text file, creating it or replacing its contents.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          content: { type: "string" },
        },
        required: ["file_path", "content"],
        additionalProperties: false,
      },
      async run(input) {
        const path = str(input, "file_path");
        const content = str(input, "content");
        if (!path || content === undefined) return fail("file_path and content are required");
        try {
          await writeFile(resolvePath(cwd, path), content, "utf8");
        } catch (err) {
          return fail(`cannot write ${path}: ${String(err)}`);
        }
        return { text: `Wrote ${content.length} characters to ${path}` };
      },
    },
    {
      name: "Edit",
      description:
        "Replace `old_string` with `new_string` in a file. `old_string` must occur exactly once unless `replace_all` is true.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["file_path", "old_string", "new_string"],
        additionalProperties: false,
      },
      async run(input) {
        const path = str(input, "file_path");
        const oldText = str(input, "old_string");
        const newText = str(input, "new_string");
        if (!path || oldText === undefined || newText === undefined)
          return fail("file_path, old_string and new_string are required");
        if (oldText === "") return fail("old_string must not be empty");
        const full = resolvePath(cwd, path);
        let text: string;
        try {
          text = await readFile(full, "utf8");
        } catch (err) {
          return fail(`cannot read ${path}: ${String(err)}`);
        }
        const occurrences = text.split(oldText).length - 1;
        if (occurrences === 0) return fail("old_string was not found in the file");
        if (occurrences > 1 && input.replace_all !== true)
          return fail(`old_string occurs ${occurrences} times; make it unique or set replace_all`);
        const updated =
          input.replace_all === true
            ? text.split(oldText).join(newText)
            : text.replace(oldText, () => newText);
        try {
          await writeFile(full, updated, "utf8");
        } catch (err) {
          return fail(`cannot write ${path}: ${String(err)}`);
        }
        return {
          text: `Replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${path}`,
        };
      },
    },
    {
      name: "Bash",
      description:
        "Run a shell command with bash in the working directory and return its output. `timeout` is in milliseconds.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "integer" },
          description: { type: "string", description: "What the command does, for the log." },
        },
        required: ["command"],
        additionalProperties: false,
      },
      run(input, signal) {
        const command = str(input, "command");
        if (!command) return Promise.resolve(fail("command is required"));
        const timeoutMs = Math.min(
          BASH_MAX_TIMEOUT_MS,
          Math.max(1000, int(input, "timeout") ?? BASH_DEFAULT_TIMEOUT_MS),
        );
        return runShell(command, cwd, timeoutMs, signal);
      },
    },
    {
      name: "Glob",
      description:
        "List files whose path matches a glob pattern (`**`, `*`, `?`), under `path` or the working directory.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
      async run(input) {
        const pattern = str(input, "pattern");
        if (!pattern) return fail("pattern is required");
        const root = resolvePath(cwd, str(input, "path") ?? ".");
        const re = globToRegExp(pattern);
        const found: string[] = [];
        await walk(root, async (full) => {
          const rel = relative(root, full).split("\\").join("/");
          if (re.test(rel) || re.test(full)) found.push(full);
          return found.length < SEARCH_MAX_MATCHES;
        });
        return { text: found.length === 0 ? "No files found" : truncate(found.join("\n")) };
      },
    },
    {
      name: "Grep",
      description:
        "Search file contents for a regular expression under `path` (default: the working directory). `include` filters file names by glob. Returns `path:line: text` matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          include: { type: "string" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      async run(input) {
        const pattern = str(input, "pattern");
        if (!pattern) return fail("pattern is required");
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch (err) {
          return fail(`invalid pattern: ${String(err)}`);
        }
        const root = resolvePath(cwd, str(input, "path") ?? ".");
        const include = str(input, "include");
        const nameRe = include ? globToRegExp(include) : undefined;
        const matches: string[] = [];
        const target = await stat(root).catch(() => undefined);
        const files: string[] = [];
        if (target?.isFile()) files.push(root);
        else
          await walk(root, async (full) => {
            if (
              nameRe === undefined ||
              nameRe.test(relative(root, full)) ||
              nameRe.test(full.split("/").pop() ?? "")
            )
              files.push(full);
            return true;
          });
        for (const file of files) {
          let text: string;
          try {
            text = await readFile(file, "utf8");
          } catch {
            continue;
          }
          if (text.includes("\u0000")) continue;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            if (re.test(line)) matches.push(`${file}:${i + 1}: ${line.slice(0, 400)}`);
            if (matches.length >= SEARCH_MAX_MATCHES) break;
          }
          if (matches.length >= SEARCH_MAX_MATCHES) break;
        }
        return { text: matches.length === 0 ? "No matches found" : truncate(matches.join("\n")) };
      },
    },
    {
      name: "LS",
      description: "List a directory's entries; directories end with a slash.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      async run(input) {
        const path = str(input, "path");
        if (!path) return fail("path is required");
        try {
          const entries = await readdir(resolvePath(cwd, path), { withFileTypes: true });
          const names = entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort((a, b) => a.localeCompare(b));
          return { text: names.length === 0 ? "(empty)" : truncate(names.join("\n")) };
        } catch (err) {
          return fail(`cannot list ${path}: ${String(err)}`);
        }
      },
    },
  ];
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  return new Promise((resolveOutcome) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < BUILTIN_OUTPUT_MAX_CHARS * 2) out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < BUILTIN_OUTPUT_MAX_CHARS) err += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveOutcome(fail(`cannot start bash: ${String(e)}`));
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const parts = [out.trimEnd()];
      if (err.trim() !== "") parts.push(`[stderr]\n${err.trimEnd()}`);
      if (timedOut) parts.push(`[killed after ${timeoutMs} ms]`);
      else if (code !== 0) parts.push(`[exit ${code ?? sig ?? "?"}]`);
      resolveOutcome({
        text: truncate(parts.filter(Boolean).join("\n")),
        ...(code === 0 && !timedOut ? {} : { isError: true }),
      });
    });
  });
}
