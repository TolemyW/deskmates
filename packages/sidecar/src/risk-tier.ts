// Risk tier: a pure function `(toolName, input) -> L0 | L1 | L2` backed by a table
// (ADR-0002 decision 2; design v0.3 §3.5). L0 read-only, L1 reversible write, L2 external side
// effect. Unknown tools are L2: the safe default is to ask.

import path from "node:path";
import type { BrowserCodeApproval, RiskLevel } from "@deskmates/contracts";
import {
  type BrowserCodeEffect,
  browserCodeEffects,
  browserToolCode,
  playwrightCliEffects,
} from "./browser-code-effects.js";
import { basename, shellArgvs, unwrapArgv } from "./shell-words.js";

/**
 * Policy knobs of the tier function, frozen per run. `browserCode` (ADR-0002 amendment 5):
 * absent or `name-v1` tiers browser code by tool name, `effects-v1` by its effects.
 */
export interface TierOptions {
  browserCode?: BrowserCodeApproval | undefined;
}

/** Where the workspace's shared files live; writes elsewhere are not reversible by the run. */
export const WORK_DIR = "/work";

/** Name of the in-process MCP server that hosts thread tools; tools appear as `mcp__deskmates__*`. */
export const DESKMATES_MCP_SERVER = "deskmates";

/**
 * The name the SDK exposes a Deskmates tool under, and so the only name a model can call it by
 * (issue #67). Prompt text names tools through this, never by the bare design name.
 */
export function deskmatesToolName(tool: string): string {
  return `mcp__${DESKMATES_MCP_SERVER}__${tool}`;
}

/** Name of the browser MCP server; tools appear as `mcp__browser__browser_*` (design §3.3). */
export const BROWSER_MCP_SERVER = "browser";

/**
 * The three browser tables below name tools that exist in `@playwright/mcp` 0.0.82 (the generated
 * tool list in its README). Names it does not define — `browser_install`, `browser_navigate_forward`,
 * `browser_tab_list`/`_select`/`_new`/`_close`, `browser_run_code` — were dead table rows, and a
 * dead row in the read table is worse than useless: it promises a tier for a call that can never
 * arrive while the real tool falls somewhere else. The tier is this project's judgement, not the
 * MCP's own `read-only` flag: `browser_navigate` is read-only here because a navigation commits
 * nothing outside the workspace and the egress allowlist gates it separately (design v0.3 §3.10).
 * A browser tool in none of the tables is L2, so whatever a later MCP release adds asks first.
 */
const BROWSER_READ_TOOLS = new Set([
  // Core automation.
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_navigate",
  "browser_navigate_back",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_find",
  "browser_wait_for",
  "browser_resize",
  "browser_hover",
  // Tab management: one tool with an `action`; `{action:"new", url}` is caught by isNavigation.
  "browser_tabs",
  // Configuration (--caps=config) and the read half of network (--caps=network).
  "browser_get_config",
  "browser_route_list",
  // DevTools (--caps=devtools): annotations and highlights only mark the page up for a human.
  "browser_annotate",
  "browser_highlight",
  "browser_hide_highlight",
  // PDF (--caps=pdf) and testing (--caps=testing): rendering and assertions, no page mutation.
  "browser_pdf_save",
  "browser_generate_locator",
  "browser_verify_element_visible",
  "browser_verify_list_visible",
  "browser_verify_text_visible",
  "browser_verify_value",
]);

const BROWSER_WRITE_TOOLS = new Set([
  // Core automation.
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_drag",
  "browser_drop",
  "browser_handle_dialog",
  "browser_emulate_media",
  "browser_close",
  "browser_evaluate",
  // 0.0.82 calls it `browser_run_code_unsafe`; `browser_run_code` never existed in the pinned release.
  "browser_run_code_unsafe",
  // Coordinate-based (--caps=vision), the capability the sidecar actually enables.
  "browser_mouse_click_xy",
  "browser_mouse_move_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_down",
  "browser_mouse_up",
  "browser_mouse_wheel",
  // Network (--caps=network): offline and latency emulation is undone by setting it back.
  "browser_network_state_set",
]);

/**
 * Browser tools that are an external side effect whatever their input. `browser_file_upload`
 * sends any file the container can read (SDK transcripts, the browser profile, another bot's
 * notes) to whatever page is open, so it always asks. The cookie and storage tools are the
 * workspace's login state: reading one puts a session cookie in the model's context, writing one
 * adopts a session from somewhere else. Request routing can rewrite a request towards a host the
 * allowlist never saw, so it asks too.
 */
const BROWSER_L2_TOOLS = new Set([
  "browser_file_upload",
  // Storage (--caps=storage).
  "browser_cookie_get",
  "browser_cookie_list",
  "browser_cookie_set",
  "browser_cookie_clear",
  "browser_cookie_delete",
  "browser_localstorage_get",
  "browser_localstorage_list",
  "browser_localstorage_set",
  "browser_localstorage_clear",
  "browser_localstorage_delete",
  "browser_sessionstorage_get",
  "browser_sessionstorage_list",
  "browser_sessionstorage_set",
  "browser_sessionstorage_clear",
  "browser_sessionstorage_delete",
  "browser_storage_state",
  "browser_set_storage_state",
  // Network (--caps=network).
  "browser_route",
  "browser_unroute",
]);

const READ_ONLY_TOOLS = new Set([
  // Loads an enabled skill's text into context (ADR-0015); what the text then asks for is judged
  // call by call here like any other tool use.
  "Skill",
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoRead",
  "WebFetch",
  "WebSearch",
]);

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const SHELL_TOOLS = new Set(["Bash", "Shell"]);

/** Words in a tool name that mean an external side effect regardless of the tool family. */
const SIDE_EFFECT_WORDS = /(submit|purchase|pay|send|delete)/i;

/**
 * Phrases in a clicked element's description that mean the click commits something outside the
 * workspace. Matched as whole words so "Orders tab", "Payment history" and "Transfers report"
 * stay navigation while "Place order", "Pay now" and "Transfer funds" ask.
 */
const SIDE_EFFECT_PHRASES =
  /\b(place order|checkout|check out|buy|confirm|transfer|publish|approve|submit|purchase|pay|send|delete)\b/i;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The side-effect phrase that makes a click L2, lower-cased, or undefined when none did. It is
 * the only stable part of a click: the rest of an element description is page wording and the
 * `ref` changes on every snapshot, so an Always rule stores `*<phrase>*` (ADR-0002 amendment 2,
 * A3). Kept here, next to the table it reads, so the tier and the pattern can never disagree.
 */
export function sideEffectPhrase(input: Record<string, unknown>): string | undefined {
  const target = `${stringInput(input, "element", "text", "key")} ${stringInput(input, "method")}`;
  const match = SIDE_EFFECT_PHRASES.exec(target);
  return match ? (match[1] ?? match[0]).toLowerCase() : undefined;
}

/** curl short options that take a value, so the rest of a combined flag word (or the next word) is it. */
const CURL_SHORT_WITH_VALUE = new Set([
  "A",
  "b",
  "c",
  "C",
  "d",
  "D",
  "e",
  "E",
  "F",
  "H",
  "K",
  "m",
  "o",
  "P",
  "Q",
  "r",
  "t",
  "T",
  "u",
  "U",
  "w",
  "x",
  "X",
  "y",
  "Y",
  "z",
]);

/** curl short options that send a body, upload a file, or load opaque command options. */
const CURL_SHORT_L2 = new Set(["d", "F", "K", "T"]);

/**
 * curl long options that send a body, upload a file, or load opaque command options
 * (`--data-raw`, `--data-binary`, ... included). A config file may contain any other curl
 * option, so using one is conservatively L2 without reading the file or stdin.
 */
const CURL_LONG_L2 = /^--(data(-\w+)?|form(-string)?|upload-file|json|config)$/;

/** git global options that take a separate value, so the subcommand is one word further on. */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
  "--list-cmds",
]);

function stringInput(input: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return "";
}

/** Strip the `mcp__<server>__` prefix, returning the server (if any) and the bare tool name. */
export function splitMcpToolName(toolName: string): { server?: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return { tool: toolName };
  return { server: m[1] ?? "", tool: m[2] ?? "" };
}

export function isBrowserTool(toolName: string): boolean {
  const { server, tool } = splitMcpToolName(toolName);
  return server === BROWSER_MCP_SERVER || tool.startsWith("browser_");
}

/** Tools that open a URL by name: subject to the egress allowlist even at L0 (design v0.3 §3.10). */
export function isNavigationTool(toolName: string): boolean {
  const { tool } = splitMcpToolName(toolName);
  return tool === "browser_navigate" || tool === "WebFetch";
}

/**
 * Whether this call opens a URL: the navigation tools by name, plus any browser tool whose input
 * carries a top-level string `url` (`browser_tabs {action:"new", url}` and whatever the MCP adds
 * next). The egress check in the PreToolUse hook uses this, not the
 * name-only predicate, so a new-tab navigation cannot skip the allowlist.
 */
export function isNavigation(toolName: string, input: Record<string, unknown>): boolean {
  if (isNavigationTool(toolName)) return true;
  return isBrowserTool(toolName) && typeof input.url === "string";
}

export function isShellTool(toolName: string): boolean {
  return (
    SHELL_TOOLS.has(splitMcpToolName(toolName).tool) || toolName === "mcp__deskmates__tty_session"
  );
}

/**
 * Whether a file path, once normalised, is inside the workspace. Relative paths resolve against
 * `/work`, and `..` segments are collapsed first so `/work/../home/nova/SOUL.md` is seen for the
 * `/home/nova/SOUL.md` it is. Symlinks are not covered: a link under /work that points outside
 * it is only caught by the container's mount layout, not here.
 */
function isUnderWorkDir(filePath: string): boolean {
  if (filePath === "") return false;
  const normalised = path.posix.resolve(WORK_DIR, filePath);
  return normalised === WORK_DIR || normalised.startsWith(`${WORK_DIR}/`);
}

/** Expand `-sSd` into `-s -S -d`, stopping at the first option that takes a value. */
function curlIsL2(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? "";
    if (w === "--") return false;
    if (w.startsWith("--")) {
      const [name, attached] = w.split(/=(.*)/s, 2) as [string, string | undefined];
      if (CURL_LONG_L2.test(name)) return true;
      if (name === "--request") {
        const method = attached ?? args[i + 1] ?? "";
        if (MUTATING_METHODS.has(method.toUpperCase())) return true;
        if (attached === undefined) i++;
      }
      continue;
    }
    if (!w.startsWith("-") || w.length < 2) continue;
    for (let j = 1; j < w.length; j++) {
      const flag = w[j] ?? "";
      if (CURL_SHORT_L2.has(flag)) return true;
      if (flag === "X") {
        const rest = w.slice(j + 1);
        const method = rest === "" ? (args[i + 1] ?? "") : rest;
        if (MUTATING_METHODS.has(method.toUpperCase())) return true;
        if (rest === "") i++;
        break;
      }
      if (CURL_SHORT_WITH_VALUE.has(flag)) {
        if (w.length === j + 1) i++;
        break;
      }
    }
  }
  return false;
}

function wgetIsL2(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? "";
    if (w === "--") return false;
    const [name, attached] = w.split(/=(.*)/s, 2) as [string, string | undefined];
    if (name === "--post-data" || name === "--post-file") return true;
    if (name === "--body-data" || name === "--body-file") return true;
    if (name === "--method") {
      const method = attached ?? args[i + 1] ?? "";
      if (MUTATING_METHODS.has(method.toUpperCase())) return true;
      if (attached === undefined) i++;
    }
  }
  return false;
}

function rmIsL2(args: readonly string[]): boolean {
  for (const w of args) {
    if (w === "--") return false;
    if (w === "--recursive") return true;
    if (w.startsWith("-") && !w.startsWith("--") && /[rR]/.test(w)) return true;
  }
  return false;
}

/** The git subcommand after global options such as `-C <dir>`, `-c k=v`, `--git-dir=<d>`. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? "";
    if (!w.startsWith("-")) return w;
    if (GIT_VALUE_OPTIONS.has(w)) i++;
  }
  return undefined;
}

/** Whether one simple command (an argv) is destructive or reaches outside the workspace. */
function argvIsL2(argv: readonly string[], opts: TierOptions): boolean {
  // Wrappers that matter by themselves, wherever they sit in the argv.
  if (argv.some((w) => basename(w) === "sudo")) return true;
  const cmd = unwrapArgv(argv);
  // ADR-0002 amendment 5, C1 and C3: Playwright CLI code and its L2-mirroring subcommands.
  if (opts.browserCode === "effects-v1") {
    const effects = playwrightCliEffects(cmd, SIDE_EFFECT_PHRASES);
    if (effects !== undefined && effects.length > 0) return true;
  }
  const name = basename(cmd[0] ?? "");
  const args = cmd.slice(1);
  switch (name) {
    case "curl":
      return curlIsL2(args);
    case "wget":
      return wgetIsL2(args);
    case "rm":
      return rmIsL2(args);
    case "git":
      return gitSubcommand(args) === "push";
    case "dd":
      return args.some((w) => w.startsWith("if="));
    case "shutdown":
    case "reboot":
    case "halt":
    case "poweroff":
      return true;
    default:
      return name.startsWith("mkfs");
  }
}

/**
 * Shell commands that are destructive or reach outside the workspace, judged per simple command
 * after tokenising: quoting, combined short flags, attached values and command substitutions
 * are honoured, so `curl -sSd x`, `rm -r -f`, `git -C /work push` and `$(git push)` all rate L2
 * while `echo 'git push'` stays L1.
 */
function shellIsL2(command: string, opts: TierOptions): boolean {
  return shellArgvs(command).some((argv) => argvIsL2(argv, opts));
}

/** Connector tools that only read: capabilities, a dry validation, a receipt (ADR-0012 item 6). */
const CONNECTOR_READ_TOOLS = new Set([
  "connector_describe",
  "connector_validate",
  "connector_status",
  "connector_receipt",
]);

/**
 * `connector_submit` is tiered by the effect class of the Gateway's stored validation, which the
 * PreToolUse hook fetches; `riskTier` is pure and cannot, so it answers L2 for it and the hook
 * replaces that answer. The tool input never decides the tier.
 */
export function isConnectorSubmit(toolName: string): boolean {
  const { server, tool } = splitMcpToolName(toolName);
  return server === DESKMATES_MCP_SERVER && tool === "connector_submit";
}

/** Integration tools that only read the catalog or the workspace's own records (ADR-0013 item 6). */
const INTEGRATION_READ_TOOLS = new Set([
  "integration_apps",
  "integration_connections",
  "integration_search",
  "integration_guide",
]);

/**
 * `integration_execute` is tiered by the catalog's `operationType` of the action, which the
 * PreToolUse hook asks the Gateway for; `riskTier` is pure and cannot, so it answers L2 and the
 * hook replaces that answer. The tool input never decides the tier.
 */
export function isIntegrationExecute(toolName: string): boolean {
  const { server, tool } = splitMcpToolName(toolName);
  return server === DESKMATES_MCP_SERVER && tool === "integration_execute";
}

/**
 * Deskmates's own tools on the in-process `deskmates` MCP server (`SidecarToolName` in contracts),
 * other than the connector and integration tools, which have their own tables above.
 * `thread_post` / `message_bot` stay inside the product; the Gateway routes them.
 * `approval_decide` records a decision on a request the thread already holds, a Gateway-side
 * write, not an action on the world: L1, so it never starts a second wait. `task_deliver` and
 * `knowledge_propose` are Gateway-side records a human still accepts.
 */
const DESKMATES_READ_TOOLS = new Set(["knowledge_search", "knowledge_read", "memory_search"]);
const DESKMATES_WRITE_TOOLS = new Set([
  // ADR-0035 decision 1: a Gateway record whose audience is the workspace's signed-in members.
  "app_publish",
  "thread_post",
  "message_bot",
  "approval_decide",
  "knowledge_propose",
  "task_checkpoint",
  "task_deliver",
]);
/** Tiered by their own rules below: `tty_session` by action, `browser_cli_workflow` always L2. */
const DESKMATES_SPECIAL_TOOLS = new Set(["tty_session", "browser_cli_workflow"]);

/**
 * SDK subagent spawns (ADR-0002 amendment 3, A5). `Agent` is the name the CLI declares to the
 * model in 0.3.278; `Task` is the name its init message reports and older releases used. L1,
 * because each tool call inside the subagent passes this hook with `agent_id` set: gating the
 * spawn adds no safety, every inner action is judged on its own.
 */
const SDK_SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** SDK read-only discovery tools (A5): listing the run's own subagents changes nothing. */
const SDK_DISCOVERY_TOOLS = new Set(["ListAgents"]);

/**
 * Pinned SDK tools that stay L2 on purpose. The amendment names no tier for them, so they keep
 * the tier the unknown-tool fallback gave them before it; listing them here makes that a decision
 * rather than an accident, and changing one is a policy change of its own.
 *
 * - `SendMessage`, `TaskStop`: message or stop another agent or session.
 * - `EnterWorktree`, `ExitWorktree`: move the session's working tree.
 * - `ReportFindings`: hands a report out of the session.
 * - Withheld by `DISALLOWED_TOOLS` in `run-once.ts`, so never offered: `AskUserQuestion`,
 *   `EnterPlanMode`, `ExitPlanMode`, `Workflow`, `CronCreate`, `CronDelete`, `CronList`,
 *   `ScheduleWakeup`. Should one be offered by mistake, it asks.
 */
const SDK_L2_TOOLS = new Set([
  "SendMessage",
  "TaskStop",
  "EnterWorktree",
  "ExitWorktree",
  "ReportFindings",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
]);

/**
 * Every built-in SDK tool the tables name. The T2 `sdk-tool-inventory.container.test.ts` reads
 * the tool list from the pinned SDK and fails on any name missing here (ADR-0002 amendment 3, A5).
 */
export const SDK_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS,
  ...FILE_WRITE_TOOLS,
  ...SHELL_TOOLS,
  "TodoWrite",
  ...SDK_SUBAGENT_TOOLS,
  ...SDK_DISCOVERY_TOOLS,
  ...SDK_L2_TOOLS,
]);

/**
 * A tier and whether any table named the tool. `unclassified` means the L2 is the fail-closed
 * default for a tool nobody tiered, not a judgement about it (ADR-0002 amendment 3, A5).
 */
export interface ToolTier {
  level: RiskLevel;
  unclassified?: true;
}

/** Whether a tier table names this tool. */
function isTabledTool(toolName: string): boolean {
  const { server, tool } = splitMcpToolName(toolName);
  if (server === DESKMATES_MCP_SERVER) {
    return (
      CONNECTOR_READ_TOOLS.has(tool) ||
      INTEGRATION_READ_TOOLS.has(tool) ||
      isConnectorSubmit(toolName) ||
      isIntegrationExecute(toolName) ||
      DESKMATES_READ_TOOLS.has(tool) ||
      DESKMATES_WRITE_TOOLS.has(tool) ||
      DESKMATES_SPECIAL_TOOLS.has(tool)
    );
  }
  if (isBrowserTool(toolName)) {
    return (
      BROWSER_READ_TOOLS.has(tool) || BROWSER_WRITE_TOOLS.has(tool) || BROWSER_L2_TOOLS.has(tool)
    );
  }
  return server === undefined && SDK_BUILTIN_TOOLS.has(tool);
}

/** A line ended by one Enter: `\r`, `\n` or `\r\n`, and no other line break. */
const ONE_LINE = /^([^\r\n]*)(\r\n|\r|\n)$/;

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The shell line a `tty_session` write types, when the write is exactly one complete line: some
 * printable text followed by one Enter, with no other control character (tab included: it is a
 * completion key, not text) and not marked `sensitive` (a password typed at a prompt is not a
 * shell line). A partial line, Ctrl-C, an escape sequence or several lines are not judged by the
 * shell rules and stay L2.
 */
function ttyShellLine(input: Record<string, unknown>): string | undefined {
  if (input.action !== "write" || input.sensitive === true) return undefined;
  const data = input.data;
  if (typeof data !== "string") return undefined;
  const line = ONE_LINE.exec(data)?.[1];
  if (line === undefined || line.trim() === "" || hasControlCharacter(line)) return undefined;
  return line;
}

/**
 * The effect labels of a browser code call under `effects-v1` (ADR-0002 amendment 5), or
 * undefined when the policy is off or the call is not a browser code tool. Empty means passive.
 */
export function browserCodeCallEffects(
  toolName: string,
  input: Record<string, unknown>,
  opts: TierOptions = {},
): BrowserCodeEffect[] | undefined {
  if (opts.browserCode !== "effects-v1" || !isBrowserTool(toolName)) return undefined;
  const body = browserToolCode(splitMcpToolName(toolName).tool, input);
  return body === undefined ? undefined : browserCodeEffects(body.code, SIDE_EFFECT_PHRASES);
}

/**
 * The effect labels of every `playwright-cli` command in a shell line under `effects-v1`, or
 * undefined when the policy is off or the line runs no effectful one (C3, C4).
 */
export function shellBrowserCodeEffects(
  command: string,
  opts: TierOptions = {},
): BrowserCodeEffect[] | undefined {
  if (opts.browserCode !== "effects-v1") return undefined;
  const labels = new Set<BrowserCodeEffect>();
  for (const argv of shellArgvs(command))
    for (const label of playwrightCliEffects(unwrapArgv(argv), SIDE_EFFECT_PHRASES) ?? [])
      labels.add(label);
  return labels.size > 0 ? [...labels].sort() : undefined;
}

function tableTier(toolName: string, input: Record<string, unknown>, opts: TierOptions): RiskLevel {
  const { server, tool } = splitMcpToolName(toolName);

  if (server === DESKMATES_MCP_SERVER && CONNECTOR_READ_TOOLS.has(tool)) return "L0";
  if (isConnectorSubmit(toolName)) return "L2";
  if (server === DESKMATES_MCP_SERVER && INTEGRATION_READ_TOOLS.has(tool)) return "L0";
  if (isIntegrationExecute(toolName)) return "L2";

  if (SIDE_EFFECT_WORDS.test(tool)) return "L2";

  if (server === DESKMATES_MCP_SERVER) {
    if (tool === "browser_cli_workflow") return "L2";
    if (tool === "tty_session") {
      if (input.action === "read") return "L0";
      if (input.action === "resize" || input.action === "close") return "L1";
      // A5: one complete line typed into the terminal is judged like the same line given to Bash.
      const line = ttyShellLine(input);
      if (line !== undefined) return shellIsL2(line, opts) ? "L2" : "L1";
      return "L2";
    }
    if (DESKMATES_READ_TOOLS.has(tool)) return "L0";
    if (DESKMATES_WRITE_TOOLS.has(tool)) return "L1";
    return "L2";
  }

  if (isBrowserTool(toolName)) {
    if (BROWSER_L2_TOOLS.has(tool)) return "L2";
    if (BROWSER_READ_TOOLS.has(tool)) return "L0";
    if (BROWSER_WRITE_TOOLS.has(tool)) {
      // ADR-0002 amendment 5, C1/C2: under effects-v1, code is at least as high as the named
      // tool with the same effect. Passive code falls through to the rules below.
      const effects = browserCodeCallEffects(toolName, input, opts);
      if (effects !== undefined && effects.length > 0) return "L2";
      // A click or key press that submits a form is an external side effect. The MCP click input
      // carries a human-readable `element` description; a POST form submit shows up there.
      const target = `${stringInput(input, "element", "text", "key")} ${stringInput(input, "method")}`;
      if (SIDE_EFFECT_PHRASES.test(target)) return "L2";
      if (/\bpost\b/i.test(stringInput(input, "method"))) return "L2";
      if (input.submit === true) return "L2";
      return "L1";
    }
    return "L2";
  }

  if (SHELL_TOOLS.has(tool)) {
    return shellIsL2(stringInput(input, "command"), opts) ? "L2" : "L1";
  }

  if (FILE_WRITE_TOOLS.has(tool)) {
    const filePath = stringInput(input, "file_path", "path", "notebook_path");
    return isUnderWorkDir(filePath) ? "L1" : "L2";
  }

  if (READ_ONLY_TOOLS.has(tool)) return "L0";
  if (tool === "TodoWrite") return "L1";
  if (SDK_SUBAGENT_TOOLS.has(tool)) return "L1";
  if (SDK_DISCOVERY_TOOLS.has(tool)) return "L0";

  return "L2";
}

/**
 * The tier of a call and whether a table named its tool (ADR-0002 amendment 3, A5). A tool in no
 * table is still L2, so a new SDK or MCP tool fails closed, but it is labelled `unclassified` so
 * the approval card and the ledger show that nobody tiered it.
 */
export function classifyTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: TierOptions = {},
): ToolTier {
  const level = tableTier(toolName, input, opts);
  if (isTabledTool(toolName)) return { level };
  return { level: "L2", unclassified: true };
}

export function riskTier(
  toolName: string,
  input: Record<string, unknown>,
  opts: TierOptions = {},
): RiskLevel {
  return classifyTool(toolName, input, opts).level;
}
