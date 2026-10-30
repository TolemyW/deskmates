// ADR-0048 decision 2: what a desktop `js` body may do, read from its text, and the network
// targets it names literally.
//
// The labels are recorded on the call's `tool_call` event for attribution; they decide no tier
// (the owner ruled out per-call approvals for desktop tools, 2026-10-17). This is a keyword scan,
// not an analysis: names can be computed and strings decoded, so a label set is what the code
// names, never a proof of what the runtime executed (decision 4). It never executes anything:
// `node:vm` only compiles. The upstream `cua` API is the installed application's and is not
// versioned here, so the patterns are deliberately broad.
//
// Amendment 1: `a11y` names the accessibility actions that need neither the pointer nor the focus,
// `browser` names code that reaches for Chromium (A2: the desktop tools never drive the browser),
// and the labels choose the call's shared-screen lease (A3): shared only when every label is
// focus-free, exclusive otherwise, and exclusive when the scan cannot place the call.

import { Script } from "node:vm";
import type { DesktopEffect, DesktopLeaseMode } from "@deskmates/contracts";
// The browser's click phrases, read from the same table so the two can never disagree.
import { SIDE_EFFECT_PHRASES } from "../risk-tier.js";

const EFFECT_PATTERNS: readonly (readonly [DesktopEffect, RegExp])[] = [
  [
    "a11y",
    /\b(doAction|do_action|setTextContents|set_text_contents|insertText|insert_text|setCurrentValue|set_current_value)\s*\(/,
  ],
  ["browser", /\bchrom(e|ium)\b|google-chrome/i],
  [
    "read",
    /\b(getState|getWindows|listWindows|windows|getTree|accessibility|getElement|findElement|find|query|getText|getValue|elements?)\s*\(/,
  ],
  ["capture", /screenshot|screen_?shot|capture|grab(Screen|Window)?\s*\(/i],
  [
    "launch",
    /\bchild_process\b|\bspawn(Sync)?\s*\(|\bexec(File|Sync|FileSync)?\s*\(|\bfork\s*\(|\blaunch\w*\s*\(|\bopen(App|Application)\s*\(|\bprocess\s*\.\s*kill\b|\bkill\s*\(|\bquit(App)?\s*\(/,
  ],
  [
    "file",
    /\bfs\b|\bnode:fs\b|\bwrite(File|FileSync)\s*\(|append(File|FileSync)\s*\(|\bunlink(Sync)?\s*\(|\brm(Sync|dir|dirSync)?\s*\(|\bmkdir(Sync)?\s*\(|\brename(Sync)?\s*\(|\bcopyFile(Sync)?\s*\(|createWriteStream/,
  ],
  [
    "network",
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bnode:(http|https|net|dgram|tls)\b|\brequire\s*\(\s*['"`](http|https|net|dgram|tls)['"`]|\bhttps?\s*\.\s*(get|request)\s*\(|\bnet\s*\.\s*connect\b|https?:\/\//,
  ],
  ["clipboard", /clipboard/i],
];

/** Input actions into a bound window: clicks, typing, keys, scrolling, dragging. */
const INPUT =
  /\.(click|doubleClick|dblclick|rightClick|tap|type|typeText|sendKeys|press|pressKey|keyPress|key|hotkey|scroll|drag|dragTo|setValue|fill|select|focus|perform|performAction)\s*\(/;

/** Dynamic code or obfuscation, as for browser code; what the scan cannot read is labelled. */
const OPAQUE: readonly RegExp[] = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bimport\s*\(/,
  /\\x[0-9a-f]{2}/i,
  /\\u\{?[0-9a-f]/i,
  /String\s*\.\s*fromCharCode|fromCodePoint/,
  /\batob\s*\(|Buffer\s*\.\s*from\s*\([^)]*['"`]base64/,
  /\bReflect\s*\.\s*(get|apply|construct)\b/,
  /\b(globalThis|cua|process|require)\s*\[/,
];

/** Whether the text compiles as an expression or as an async function body; never runs it. */
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
 * The effect labels of a `js` body, sorted and deduplicated. An empty, non-string or
 * non-compiling body is `opaque`. A body that names nothing listed has no label.
 */
export function desktopCodeEffects(code: unknown): DesktopEffect[] {
  if (typeof code !== "string" || code.trim() === "") return ["opaque"];
  const labels = new Set<DesktopEffect>();
  if (!compiles(code) || OPAQUE.some((pattern) => pattern.test(code))) labels.add("opaque");
  for (const [label, pattern] of EFFECT_PATTERNS) if (pattern.test(code)) labels.add(label);
  if (INPUT.test(code)) {
    const phrase = SIDE_EFFECT_PHRASES.exec(code);
    labels.add(phrase ? `input ${(phrase[1] ?? phrase[0]).toLowerCase()}` : "input");
  }
  return [...labels].sort();
}

/** A URL literal in code: scheme, host, and the rest up to a quote, space or bracket. */
const URL_LITERAL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)\]}]+/gi;

/**
 * The network targets a body names literally, as URL strings, sorted and deduplicated. What the
 * code computes at run time is not here; the managed egress proxy sees that (decision 2).
 */
export function desktopCodeTargets(code: unknown): string[] {
  if (typeof code !== "string") return [];
  const urls = new Set<string>();
  for (const match of code.matchAll(URL_LITERAL)) urls.add(match[0]);
  return [...urls].sort();
}

/** Labels whose calls need neither the pointer nor the keyboard focus (amendment 1, A3). */
const FOCUS_FREE: ReadonlySet<DesktopEffect> = new Set<DesktopEffect>(["a11y", "capture", "read"]);

/**
 * The shared-screen lease a desktop call takes (A3): `shared` for `js_reset` and for code whose
 * labels are all focus-free; `exclusive` for raw input, focus changes, launches, the clipboard,
 * anything opaque, and code the scan cannot place at all (fail safe).
 */
export function desktopLeaseMode(tool: string, input: Record<string, unknown>): DesktopLeaseMode {
  if (tool === "js_reset") return "shared";
  if (tool !== "js") return "exclusive";
  const labels = desktopCodeEffects(desktopToolCode(tool, input));
  return labels.length > 0 && labels.every((label) => FOCUS_FREE.has(label))
    ? "shared"
    : "exclusive";
}

/** The code of a desktop tool call: `js` carries it under `code`; `js_reset` has none. */
export function desktopToolCode(tool: string, input: Record<string, unknown>): unknown {
  return tool === "js" ? (input.code ?? input.source ?? input.script) : undefined;
}
