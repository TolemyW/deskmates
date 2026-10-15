// T0, ADR-0002 amendment 5 (issue #78): the effect scan of generic browser code. A keyword scan
// is a guard rail, not a boundary; these cases pin what it promises: every effect a named L2 tool
// asks about is found in code, passive DOM reads find nothing, unreadable code is `opaque`, and
// nothing is ever executed.

import { describe, expect, it } from "vitest";
import {
  browserCodeEffects,
  describeBrowserCode,
  playwrightCliEffects,
} from "./browser-code-effects.js";

// The named click's side-effect phrases (risk-tier.ts); a copy keeps this test pure.
const PHRASES =
  /\b(place order|checkout|check out|buy|confirm|transfer|publish|approve|submit|purchase|pay|send|delete)\b/i;

const effects = (code: unknown) => browserCodeEffects(code, PHRASES);

describe("effects a named L2 tool asks about are found in code (C1)", () => {
  it.each([
    ["async (page) => { await page.locator('#f').setInputFiles('/work/a.txt'); }", ["upload"]],
    [
      "async (page) => { const c = page.waitForEvent('filechooser'); await page.click('#up'); (await c).setFiles('/work/a'); }",
      ["upload"],
    ],
    ["() => { document.querySelector('form').submit(); }", ["submit"]],
    ["() => { document.forms[0].requestSubmit(); }", ["submit"]],
    ["() => fetch('/api/items', { method: 'POST', body: '{}' })", ["network"]],
    ["() => { const x = new XMLHttpRequest(); x.open('GET', '/a'); }", ["network"]],
    ["() => navigator.sendBeacon('/log', 'x')", ["network"]],
    ["async (page) => page.request.post('https://ops.example.test/api')", ["network"]],
    ["async (page) => { await page.goto('https://elsewhere.example.test'); }", ["navigation"]],
    ["() => { location.href = 'https://elsewhere.example.test'; }", ["navigation"]],
    ["() => { window.open('https://elsewhere.example.test'); }", ["navigation"]],
    [
      "async (page) => { const d = page.waitForEvent('download'); await page.click('#x'); await (await d).saveAs('/tmp/x'); }",
      ["download"],
    ],
    ["() => navigator.clipboard.readText()", ["clipboard"]],
    ["() => document.cookie", ["storage"]],
    ["() => localStorage.setItem('k', 'v')", ["storage"]],
    ["async (page) => page.context().addCookies([])", ["storage"]],
    ["async (page) => page.context().storageState()", ["storage"]],
    ["async (page) => page.route('**/*', (r) => r.continue())", ["routing"]],
    [
      "async (page) => { await page.getByRole('button', { name: 'Delete' }).click(); }",
      ["click delete"],
    ],
    ["(element) => element.click() /* Place order */", ["click place order"]],
  ])("%s -> %j", (code, expected) => {
    expect(effects(code)).toEqual(expected);
  });

  it("returns several labels sorted and deduplicated", () => {
    expect(
      effects(
        "async (page) => { await page.setInputFiles('#f', '/work/a'); await fetch('/x'); await fetch('/y'); }",
      ),
    ).toEqual(["network", "upload"]);
  });
});

describe("passive inspection finds no effect, so it keeps L1 (C1)", () => {
  it.each([
    "() => document.title",
    "(element) => element.textContent",
    "() => Array.from(document.querySelectorAll('tr')).map((r, i) => r.cells[i + 1]?.innerText)",
    "async (page) => { return await page.locator('h1').innerText(); }",
    "() => ({ url: location.href, len: document.body.innerHTML.length })",
    "() => location.href === 'x'",
    // A phrase without an interaction reads; a click without a phrase is the named click's L1.
    "() => document.querySelector('#delete-help').textContent",
    "async (page) => { await page.getByRole('link', { name: 'Next page' }).click(); }",
  ])("%s", (code) => {
    expect(effects(code)).toEqual([]);
  });
});

describe("code the scan cannot read fails closed (C2)", () => {
  it.each([
    ["missing", undefined],
    ["not a string", { code: 1 }],
    ["empty", "  "],
    ["syntax error", "async (page) => { await page.click("],
    ["eval", "() => eval('1')"],
    ["Function", "() => new Function('return 1')()"],
    ["dynamic import", "async () => import('x')"],
    ["hex escape", "() => window['\\x66etch']"],
    ["unicode escape", "() => '\\u0066etch'"],
    ["fromCharCode", "() => String.fromCharCode(102)"],
    ["atob", "() => atob('ZmV0Y2g=')"],
    ["computed global", "() => window['fe' + 'tch']('/x')"],
    ["computed page member", "async (page) => page[name]('x')"],
    ["init script", "async (page) => page.addInitScript(() => 1)"],
    ["string timer", "() => setTimeout('x()', 1)"],
  ])("%s", (_label, code) => {
    expect(effects(code)).toContain("opaque");
  });

  it("compiles without executing", () => {
    const marker = "__browser_code_effects_executed__";
    const code = `(() => { globalThis.${marker} = true; throw new Error('ran'); })()`;
    expect(effects(code)).toEqual([]);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it("accepts a bare function body as readable code", () => {
    expect(effects("await page.locator('h1').innerText();")).toEqual([]);
  });
});

describe("playwright-cli argv (C3)", () => {
  const cli = (...words: string[]) => playwrightCliEffects(words, PHRASES);

  it("is not a playwright-cli command", () => {
    expect(cli("ls", "-la")).toBeUndefined();
    expect(cli()).toBeUndefined();
  });

  it.each([
    [["playwright-cli", "upload", "/work/a.txt"], ["upload"]],
    [["playwright-cli", "-s=bot", "cookie-set", "a", "b"], ["storage"]],
    [["playwright-cli", "localstorage-get", "k"], ["storage"]],
    [["playwright-cli", "state-load", "/work/s.json"], ["storage"]],
    [["playwright-cli", "route", "**/*"], ["routing"]],
    [["/usr/bin/playwright-cli", "eval", "() => fetch('/x', {method:'POST'})"], ["network"]],
    [
      ["npx", "playwright-cli", "run-code", "async (page) => page.setInputFiles('#f', '/a')"],
      ["upload"],
    ],
    [["playwright-cli", "--raw", "run-code", "--filename=/work/p.js"], ["opaque"]],
    [["playwright-cli", "eval"], ["opaque"]],
    [["playwright-cli", "eval", "() => document.title"], []],
    [["playwright-cli", "snapshot"], []],
    [["playwright-cli", "click", "e12"], []],
  ])("%j -> %j", (argv, expected) => {
    expect(cli(...argv)).toEqual(expected);
  });
});

describe("describeBrowserCode (C4)", () => {
  it("names the effects and binds the pattern to the exact code", () => {
    const a = describeBrowserCode(["network", "upload"], "code A", { maxChars: 200 });
    const again = describeBrowserCode(["network", "upload"], "code A", { maxChars: 200 });
    const b = describeBrowserCode(["network", "upload"], "code B", { maxChars: 200 });
    expect(a.summary).toMatch(/^page code: network, upload sha256:[0-9a-f]{64}$/);
    expect(a.pattern).toMatch(/^\* sha256:[0-9a-f]{64}$/);
    expect(a.summary.endsWith(a.pattern.slice(2))).toBe(true);
    expect(again).toEqual(a);
    expect(b.pattern).not.toBe(a.pattern);
  });

  it("shortens the label list, never the hash, to fit", () => {
    const labels = Array.from({ length: 30 }, (_, i) => `click phrase-${i}`);
    const d = describeBrowserCode(labels, "x", {
      prefix: "playwright-cli eval ... | ",
      maxChars: 200,
    });
    expect(d.summary.length).toBeLessThanOrEqual(200);
    expect(d.summary.endsWith(d.pattern.slice(2))).toBe(true);
  });
});
