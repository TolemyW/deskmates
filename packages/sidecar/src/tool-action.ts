// Build the `ToolAction` an approval request carries: the raw call plus the dimensions approval
// rules match on (design v0.3 §3.5). Derived once here so the Gateway never re-parses tool input.

import { createHash } from "node:crypto";
import path from "node:path";
import { ARGUMENT_TRUNCATION_MARKER, type ToolAction } from "@deskmates/contracts";
import { browserToolCode, describeBrowserCode } from "./browser-code-effects.js";
import {
  type TierOptions,
  WORK_DIR,
  browserCodeCallEffects,
  isBrowserTool,
  isNavigation,
  isShellTool,
  isSubagentSpawn,
  shellBrowserCodeEffects,
  sideEffectPhrase,
  splitMcpToolName,
} from "./risk-tier.js";
import { basename, hasExpandedCommandWord, shellArgvs, unwrapArgv } from "./shell-words.js";

const URL_KEYS = ["url", "uri", "href"] as const;
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

const FETCHERS = new Set(["curl", "wget"]);
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>()]+/g;

/** Commands that print where a binary lives: `which curl` resolves a fetcher at run time. */
const RESOLVERS = new Set(["which", "whereis", "type", "hash"]);

/** A `$(...)` or backtick body that names a fetcher: the command that runs is not readable here. */
const FETCHER_IN_SUBSTITUTION = /(\$\([^)]*|`[^`]*)\b(curl|wget)\b/;

/** Whether an argv word is curl or wget, whatever directory path is in front of it. */
function isFetcherWord(word: string): boolean {
  return FETCHERS.has(basename(word));
}

/**
 * Whether the command resolves a fetcher at run time (`$(which curl) ...`, `x=$(command -v wget)`)
 * or runs a program whose name is expanded at run time (`$c ...`, `${c} ...`;
 * `hasExpandedCommandWord`), so the literal URLs in it cannot be trusted to describe what runs.
 * A script run from a file or stdin (`bash s.sh`, `... | sh`, `source f`) is not counted: it is
 * L2 in the risk tier and goes to the approval path, not to an egress denial.
 */
function hasOpaqueFetcher(command: string): boolean {
  if (FETCHER_IN_SUBSTITUTION.test(command)) return true;
  return shellArgvs(command).some((argv) => {
    if (hasExpandedCommandWord(argv)) return true;
    const head = basename(argv[0] ?? "");
    const rest = argv.slice(1);
    if (RESOLVERS.has(head)) return rest.some(isFetcherWord);
    // `command curl ...` runs curl; `command -v curl` only locates it.
    if (head === "command") return rest.some((w) => /^-[vV]$/.test(w)) && rest.some(isFetcherWord);
    return false;
  });
}

/**
 * Whether a shell command fetches from the network with curl or wget. Such a command is treated as
 * navigation: every URL in it must be on the egress allowlist, and a command with none is denied
 * because its target cannot be checked. This is the M0 tool-level rule; network-level egress in
 * the sandbox provider replaces it in M1.
 *
 * The command is tokenised (shell-words.ts), so `/usr/bin/curl`, `env curl`, `xargs curl`,
 * `bash -c "curl ..."` and `ls&&curl` are all seen. Any argv word whose basename is curl or wget
 * counts, not only the first: an unknown wrapper cannot hide the fetcher, at the price of
 * denying the odd harmless `grep curl file` (no URL to check). A fetcher named inside a
 * substitution (`$(which curl)`) counts too, and so does a program word expanded at run time
 * (`$c https://…`, `bash -lc "$x"`), which may be a fetcher nobody can see; see `shellHosts` for
 * what it reports.
 */
export function isShellFetch(command: string): boolean {
  return shellArgvs(command).some((argv) => argv.some(isFetcherWord)) || hasOpaqueFetcher(command);
}

/**
 * Hostnames of every http(s) URL in a shell command, read from the tokenised argv words so quoted
 * URLs (`'https://h/?a=1&b=2'`) and attached values (`--url=https://h`) are found; unparsable
 * URLs are returned as undefined. A command that resolves its fetcher at run time reports no
 * host at all, so the hook denies it as having no readable URL.
 */
export function shellHosts(command: string): (string | undefined)[] {
  if (hasOpaqueFetcher(command)) return [];
  const hosts = new Set<string | undefined>();
  for (const argv of shellArgvs(command)) {
    for (const word of argv) {
      for (const m of word.matchAll(URL_IN_TEXT)) {
        try {
          hosts.add(new URL(m[0]).hostname.toLowerCase());
        } catch {
          hosts.add(undefined);
        }
      }
    }
  }
  return [...hosts];
}

/**
 * Every http(s) URL in a shell command, as written (ADR-0027 amendment 1): a network-profile
 * grant matches scheme and port too, which `shellHosts` drops.
 */
export function shellUrls(command: string): string[] {
  if (hasOpaqueFetcher(command)) return [];
  const urls = new Set<string>();
  for (const argv of shellArgvs(command))
    for (const word of argv) for (const m of word.matchAll(URL_IN_TEXT)) urls.add(m[0]);
  return [...urls];
}

/** The URL string in a tool input, or undefined when there is none. */
export function targetUrl(input: Record<string, unknown>): string | undefined {
  for (const k of URL_KEYS) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Hostname of the URL in a tool input, or undefined when there is none or it does not parse. */
export function targetHost(input: Record<string, unknown>): string | undefined {
  for (const k of URL_KEYS) {
    const v = input[k];
    if (typeof v !== "string") continue;
    try {
      return new URL(v).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function targetOrigin(input: Record<string, unknown>): string | undefined {
  for (const k of URL_KEYS) {
    const v = input[k];
    if (typeof v !== "string") continue;
    try {
      return new URL(v).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Longest `argumentSummary`; it goes into an approval message a human reads, not into a log. */
export const ARGUMENT_SUMMARY_MAX_CHARS = 200;

/**
 * Browser tools that act on an element the page named. Their input carries a human-readable
 * `element` description and a `ref` that changes on every snapshot, so the summary keeps the
 * description and the pattern keeps only the phrase that made the call L2.
 */
const BROWSER_ELEMENT_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_drop",
  "browser_file_upload",
]);

/** Programs whose next word is a URL, not a subcommand: the pattern keeps the program alone. */
const FETCHER_PROGRAMS = new Set(["curl", "wget"]);

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function truncateSummary(text: string): string {
  return text.length <= ARGUMENT_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, ARGUMENT_SUMMARY_MAX_CHARS - 1)}${ARGUMENT_TRUNCATION_MARKER}`;
}

function stringInput(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** The raw URL text of a tool input, unparsed: the summary shows what the model asked for. */
function rawUrl(input: Record<string, unknown>): string | undefined {
  return stringInput(input, ...URL_KEYS);
}

/** The element description, the typed text, or the snapshot ref, whichever the input carries. */
function elementSummary(input: Record<string, unknown>): string {
  const raw = stringInput(input, "element", "text", "ref") ?? "";
  return collapse(raw.replace(/["'`]/g, "")).toLowerCase();
}

/**
 * The glob a shell command's Always rule stores: the program and, when the next word is a
 * subcommand rather than an option or a URL, that subcommand too (`git push*`, `rm*`, `curl *`).
 * Everything after it — remotes, branches, paths, query strings — changes between runs.
 */
function shellPattern(command: string): string | undefined {
  const argv = shellArgvs(command)
    .map(unwrapArgv)
    .find((a) => a.length > 0);
  if (argv === undefined) return undefined;
  const program = basename(argv[0] ?? "");
  if (program === "") return undefined;
  if (FETCHER_PROGRAMS.has(program)) return `${program} *`;
  const next = argv[1];
  if (next !== undefined && next !== "" && !next.startsWith("-")) return `${program} ${next}*`;
  return `${program}*`;
}

/**
 * Build the `ToolAction` for a call. `opts.currentOrigin` is the origin of the page the run last
 * navigated to (tracked by the hook): a browser tool that carries no URL of its own is happening
 * on that page, and without it every click would look like a call against an unknown origin and
 * match no stored rule (ADR-0002 amendment 2, A3).
 */
export function toToolAction(
  toolName: string,
  input: Record<string, unknown>,
  opts: { currentOrigin?: string | undefined } & TierOptions = {},
): ToolAction {
  const action: ToolAction = { toolName, input };
  const origin =
    (toolName === "mcp__deskmates__browser_cli_workflow"
      ? targetOrigin({ url: input.expectedOrigin })
      : undefined) ??
    targetOrigin(input) ??
    (isBrowserTool(toolName) ? opts.currentOrigin : undefined);
  if (origin !== undefined) action.targetOrigin = origin;
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string") {
      action.filePath = v;
      break;
    }
  }

  const { summary, pattern } =
    describeBrowserCodeCall(toolName, input, opts) ??
    describeArguments(toolName, input, action.filePath);
  if (summary !== undefined && summary !== "") action.argumentSummary = truncateSummary(summary);
  if (pattern !== undefined) action.argumentPattern = pattern;
  // ADR-0002 amendment 3, A6: with no pattern, path or origin there is no stable target to build
  // an Always rule from, and the summary of a free-text input is not one (it may be truncated).
  // The input's hash is: a rule bound to it matches this exact input again and nothing else.
  if (pattern === undefined && action.filePath === undefined && action.targetOrigin === undefined)
    action.inputSha256 = createHash("sha256")
      .update(JSON.stringify(input) ?? "")
      .digest("hex");
  return action;
}

/**
 * ADR-0002 amendment 5, C4: under `effects-v1` a browser code call, or a shell line running an
 * effectful `playwright-cli` command, names its effects and binds Always to the exact code by
 * hash, so `playwright-cli eval*` or "any upload code" can never become a rule. Undefined when
 * the policy is off or the call is neither.
 */
function describeBrowserCodeCall(
  toolName: string,
  input: Record<string, unknown>,
  opts: TierOptions,
): { summary: string; pattern: string } | undefined {
  const codeEffects = browserCodeCallEffects(toolName, input, opts);
  if (codeEffects !== undefined) {
    const body = browserToolCode(splitMcpToolName(toolName).tool, input);
    return describeBrowserCode(codeEffects, body?.code, { maxChars: ARGUMENT_SUMMARY_MAX_CHARS });
  }
  if (!isShellTool(toolName)) return undefined;
  const command = stringInput(input, "command") ?? "";
  const shellEffects = shellBrowserCodeEffects(command, opts);
  if (shellEffects === undefined) return undefined;
  // The card shows the start of the command, then the effects and the hash the pattern binds to.
  return describeBrowserCode(shellEffects, command, {
    prefix: `${collapse(command).slice(0, 48)} | `,
    maxChars: ARGUMENT_SUMMARY_MAX_CHARS,
  });
}

/**
 * One line naming the arguments a rule may match on, plus the stable glob an Always decision
 * stores for them. Never tool output: only what the model asked for. Navigation and file tools
 * get no pattern — their dimension is the origin and the path, both already on the action.
 */
function describeArguments(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string | undefined,
): { summary?: string; pattern?: string } {
  if (
    toolName === "mcp__deskmates__tty_session" ||
    toolName === "mcp__deskmates__browser_cli_workflow"
  ) {
    // Bind an Always/replay decision to the full structured action, never a truncated prefix.
    const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
    const detail = toolName.endsWith("tty_session")
      ? input.action === "write"
        ? `write ${String(input.data ?? "").length} ${input.sensitive === true ? "sensitive " : ""}characters to ${String(input.sessionId ?? "unknown terminal")}`
        : `${String(input.action ?? "terminal")} ${String(input.command ?? input.sessionId ?? "")}`
      : `browser workflow on ${String(input.expectedOrigin ?? "unknown origin")} (${Array.isArray(input.steps) ? input.steps.length : 0} steps)`;
    return {
      summary: `${collapse(detail).slice(0, 120)} ${fingerprint}`,
      pattern: `* ${fingerprint}`,
    };
  }
  if (isNavigation(toolName, input)) {
    const url = rawUrl(input);
    return url === undefined ? {} : { summary: collapse(url) };
  }
  if (isShellTool(toolName)) {
    const command = stringInput(input, "command") ?? "";
    const pattern = shellPattern(command);
    return { summary: collapse(command), ...(pattern === undefined ? {} : { pattern }) };
  }
  if (isBrowserTool(toolName)) {
    const { tool } = splitMcpToolName(toolName);
    if (BROWSER_ELEMENT_TOOLS.has(tool)) {
      const phrase = sideEffectPhrase(input);
      return {
        summary: elementSummary(input),
        ...(phrase === undefined ? {} : { pattern: `*${phrase}*` }),
      };
    }
  }
  if (isSubagentSpawn(toolName)) {
    // A6: a spawn's stable target is its subagent type; its description and prompt are free
    // text that changes every time. An absent type is the SDK's default, kept apart by name.
    const type = collapse(stringInput(input, "subagent_type") ?? "default").replace(/\*/g, "");
    const description = collapse(stringInput(input, "description", "prompt") ?? "");
    return { summary: `agent ${type}: ${description}`, pattern: `agent ${type}: *` };
  }
  if (filePath !== undefined) return { summary: path.posix.resolve(WORK_DIR, filePath) };
  return { summary: collapse(JSON.stringify(input) ?? "") };
}
