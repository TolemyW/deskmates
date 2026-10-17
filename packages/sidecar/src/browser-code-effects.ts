// ADR-0002 amendment 5 (issue #78): what generic browser code may do, read from its text.
//
// `browser_run_code_unsafe`, `browser_evaluate` and `playwright-cli eval` / `run-code` run
// arbitrary JavaScript. Tiered by tool name they are L1, while the named tool with the same effect
// (`browser_file_upload`, the storage tools, `browser_route`, a "Delete" click) is L2. Under the
// opt-in `effects-v1` policy the risk tier asks this module which effect classes the code may
// have, and any one of them makes the call L2.
//
// This is a keyword scan, not an analysis: names can be computed and strings decoded, so it is a
// guard rail and never a security boundary. It fails closed where it can tell it cannot read the
// code (`opaque`), and it never executes anything: `node:vm` only compiles.

import { createHash } from "node:crypto";
import { Script } from "node:vm";

/** Fixed effect labels, as the approval card shows them (C1, C2). */
export type BrowserCodeEffect =
  | "clipboard"
  | "download"
  | "navigation"
  | "network"
  | "opaque"
  | "routing"
  | "storage"
  | "submit"
  | "upload"
  | `click ${string}`;

/** Effect classes the named browser tools already ask about (C1). Each list is any-of. */
const EFFECT_PATTERNS: readonly (readonly [BrowserCodeEffect, RegExp])[] = [
  ["upload", /setInputFiles|filechooser|\.files\s*=(?!=)|\bDataTransfer\b/i],
  ["submit", /\.submit\s*\(|\brequestSubmit\b/],
  [
    "network",
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b|\.request\s*\.\s*(get|post|put|patch|delete|head|fetch)\s*\(|\brequest\s*\.\s*newContext\b/,
  ],
  [
    "navigation",
    /\.goto\s*\(|\blocation\s*=(?!=)|\blocation\s*\.\s*href\s*=(?!=)|\blocation\s*\.\s*(assign|replace)\s*\(|\bwindow\s*\.\s*open\s*\(|\bnewPage\s*\(/,
  ],
  [
    "download",
    /waitForEvent\s*\(\s*['"`]download|\bon\s*\(\s*['"`]download|\.saveAs\s*\(|\.download\s*=(?!=)/,
  ],
  ["clipboard", /clipboard|grantPermissions/i],
  [
    "storage",
    /document\s*\.\s*cookie|\.cookies\s*\(|addCookies|clearCookies|cookieStore|localStorage|sessionStorage|indexedDB|storageState|\bcaches\s*\./,
  ],
  [
    "routing",
    /\.route\s*\(|\.unroute|routeFromHAR|routeWebSocket|setExtraHTTPHeaders|setHTTPCredentials/,
  ],
];

/** Interactions that act on an element, as the named click, type, press and select tools do. */
const INTERACTION =
  /\.(click|dblclick|tap|press|pressSequentially|check|uncheck|setChecked|selectOption|fill|type|dispatchEvent)\s*\(/;

/** Dynamic code or obfuscation: what the scan cannot read is not assumed harmless (C2). */
const OPAQUE: readonly RegExp[] = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bimport\s*\(/,
  /\brequire\s*\(/,
  /\\x[0-9a-f]{2}/i,
  /\\u\{?[0-9a-f]/i,
  /String\s*\.\s*fromCharCode|fromCodePoint/,
  /\batob\s*\(/,
  /\bReflect\s*\.\s*(get|apply|construct)\b/,
  /addInitScript|exposeFunction|exposeBinding/,
  /\bset(Timeout|Interval)\s*\(\s*['"`]/,
  // Computed access on a global or a Playwright object: `window['fe' + 'tch']`, `page[name]`.
  /\b(window|globalThis|self|top|parent|document|navigator|location|page|context|browser)\s*\[/,
];

/** Whether the text compiles as an expression or, failing that, as an async function body. */
function compiles(code: string): boolean {
  for (const source of [`(${code}\n)`, `(async () => {\n${code}\n})`]) {
    try {
      new Script(source);
      return true;
    } catch {
      // Try the next form.
    }
  }
  return false;
}

/**
 * The effect labels of a code body, sorted and deduplicated; empty means passive (L1).
 * `phrases` is the side-effect phrase pattern of the named click (risk-tier.ts), passed in so the
 * two can never disagree.
 */
export function browserCodeEffects(code: unknown, phrases: RegExp): BrowserCodeEffect[] {
  if (typeof code !== "string" || code.trim() === "") return ["opaque"];
  const labels = new Set<BrowserCodeEffect>();
  if (!compiles(code) || OPAQUE.some((pattern) => pattern.test(code))) labels.add("opaque");
  for (const [label, pattern] of EFFECT_PATTERNS) if (pattern.test(code)) labels.add(label);
  if (INTERACTION.test(code)) {
    const match = phrases.exec(code);
    if (match) labels.add(`click ${(match[1] ?? match[0]).toLowerCase()}`);
  }
  return [...labels].sort();
}

/** Browser MCP tools whose input is code, and the key that holds it. */
const CODE_TOOLS: Readonly<Record<string, string>> = {
  browser_run_code_unsafe: "code",
  browser_evaluate: "function",
};

/** The code of a browser code tool call, or undefined when the tool is not one. */
export function browserToolCode(
  tool: string,
  input: Record<string, unknown>,
): { code: unknown } | undefined {
  const key = CODE_TOOLS[tool];
  return key === undefined ? undefined : { code: input[key] };
}

/** `playwright-cli` subcommands that mirror an L2 MCP tool (C3). */
const CLI_L2_SUBCOMMAND =
  /^(upload|cookie.*|localstorage.*|sessionstorage.*|state-.*|route|unroute)$/;

/**
 * The effect labels of a `playwright-cli` argv (after the shell wrappers are unwrapped), or
 * undefined when it is not one. `npx playwright-cli` counts. `eval` and `run-code` are scanned
 * like MCP code; `run-code --filename=<f>` is `opaque`, because the hook does not read files.
 */
export function playwrightCliEffects(
  argv: readonly string[],
  phrases: RegExp,
): BrowserCodeEffect[] | undefined {
  let words = argv;
  if (basenameOf(words[0]) === "npx") words = words.slice(1).filter((w) => !w.startsWith("-"));
  if (basenameOf(words[0]) !== "playwright-cli") return undefined;
  const rest = words.slice(1);
  const index = rest.findIndex((w) => !w.startsWith("-"));
  const subcommand = index < 0 ? undefined : rest[index];
  if (subcommand === undefined) return [];
  if (CLI_L2_SUBCOMMAND.test(subcommand)) {
    if (subcommand === "upload") return ["upload"];
    return [subcommand.includes("route") ? "routing" : "storage"];
  }
  if (subcommand !== "eval" && subcommand !== "run-code") return [];
  const args = rest.slice(index + 1);
  if (args.some((w) => w === "--filename" || w.startsWith("--filename="))) return ["opaque"];
  return browserCodeEffects(
    args.find((w) => !w.startsWith("-")),
    phrases,
  );
}

function basenameOf(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

/**
 * Card text and Always pattern of an L2 code call (C4): effects plus a hash of the exact code.
 * The summary never exceeds `maxChars`; the label list is shortened first, so the hash the
 * pattern binds to is always whole.
 */
export function describeBrowserCode(
  labels: readonly string[],
  code: unknown,
  opts: { prefix?: string; maxChars: number },
): { summary: string; pattern: string } {
  const text = typeof code === "string" ? code : JSON.stringify(code ?? null);
  const fingerprint = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const head = `${opts.prefix ?? ""}page code: `;
  let list = labels.length > 0 ? labels.join(", ") : "no listed effect";
  const room = opts.maxChars - head.length - fingerprint.length - 1;
  if (list.length > room) list = `${list.slice(0, Math.max(0, room - 1))}…`;
  return { summary: `${head}${list} ${fingerprint}`, pattern: `* ${fingerprint}` };
}
