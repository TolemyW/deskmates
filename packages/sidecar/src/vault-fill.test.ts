// @vitest-environment jsdom
// T0/T1 (ADR-0045 decision 5): the fixed fill command. Over a fake CDP it refuses a stale tab, a
// tab or frame on another origin and an unknown frame before anything reaches the page; the value
// travels only as call arguments, never in the function source; the answer is a status. In a DOM
// the in-page function rechecks the origins and the URL, fills a password only into a password
// input, finds the username field before it, fires the input events a page listens for, and never
// submits. The real-browser rows are the T2 `acceptance/m4-vault-browser.container.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CdpSession,
  VAULT_FILL_PAGE_FUNCTION,
  type VaultFillDeps,
  parseVaultFillInput,
  vaultFill,
  vaultFillCommand,
} from "./vault-fill.js";

const USER = "synthetic-fill-user-31d2";
const PASSWORD = "synthetic-fill-password-c8a0";

type PageFn = (
  expectedOrigin: string,
  startHref: string,
  usernameSelector: string,
  passwordSelector: string,
  username: string,
  password: string,
) => string;
const inPage = new Function(`return (${VAULT_FILL_PAGE_FUNCTION})`)() as PageFn;

/** The jsdom globals this test touches; this package compiles without the DOM library. */
interface Field {
  value: string;
  addEventListener(type: string, listener: () => void): void;
}
interface Dom {
  document: { body: { innerHTML: string }; getElementById(id: string): Field | null };
  location: { origin: string; href: string };
  Element: { prototype: { getClientRects: () => unknown } };
}
const dom = globalThis as unknown as Dom;

describe("the in-page fill", () => {
  const rects = dom.Element.prototype.getClientRects;
  beforeEach(() => {
    // jsdom lays nothing out; every element counts as visible here.
    dom.Element.prototype.getClientRects = () => [{}];
  });
  afterEach(() => {
    dom.Element.prototype.getClientRects = rects;
    dom.document.body.innerHTML = "";
  });
  const here = () => [dom.location.origin, dom.location.href] as const;

  it("fills the username before the password field and the password field, firing input events", () => {
    dom.document.body.innerHTML = `<form id="f"><input name="search" type="search">
      <input id="u" type="email"><input id="p" type="password"><button>Sign in</button></form>`;
    let submitted = false;
    dom.document.getElementById("f")?.addEventListener("submit", () => {
      submitted = true;
    });
    const events: string[] = [];
    dom.document.getElementById("p")?.addEventListener("input", () => events.push("password"));
    dom.document.getElementById("u")?.addEventListener("input", () => events.push("username"));
    const [origin, href] = here();
    expect(inPage(origin, href, "", "", USER, PASSWORD)).toBe("filled");
    expect(dom.document.getElementById("u")?.value).toBe(USER);
    expect(dom.document.getElementById("p")?.value).toBe(PASSWORD);
    expect(events).toEqual(["username", "password"]);
    expect(submitted).toBe(false);
  });

  it("refuses a password into anything but a password input", () => {
    dom.document.body.innerHTML = `<input id="u" type="text"><input id="p" type="password">`;
    const [origin, href] = here();
    expect(inPage(origin, href, "", "#u", USER, PASSWORD)).toBe("not_password_field");
    expect(dom.document.getElementById("u")?.value).toBe("");
  });

  it("refuses another origin, a navigated page, missing and ambiguous fields", () => {
    dom.document.body.innerHTML = `<input type="text"><input type="password"><input type="password">`;
    const [origin, href] = here();
    expect(inPage("https://other.example.test", href, "", "", USER, PASSWORD)).toBe(
      "frame_mismatch",
    );
    expect(inPage(origin, `${href}#moved`, "", "", USER, PASSWORD)).toBe("navigated");
    expect(inPage(origin, href, "", "", USER, PASSWORD)).toBe("ambiguous_fields");
    dom.document.body.innerHTML = `<input type="text">`;
    expect(inPage(origin, href, "", "", USER, PASSWORD)).toBe("missing_fields");
    expect(inPage(origin, href, "", "#nope", USER, PASSWORD)).toBe("missing_fields");
  });
});

interface Frame {
  id: string;
  url: string;
}

function cdp(options: { targetUrl?: string; frames?: Frame[]; pageAnswer?: string } = {}) {
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const top = options.frames?.[0] ?? { id: "f0", url: "https://console.example.test/login" };
  const deps: VaultFillDeps = {
    listTargets: async () => [
      {
        id: "tab-1",
        type: "page",
        url: options.targetUrl ?? top.url,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab-1",
      },
    ],
    connect: async (): Promise<CdpSession> => ({
      async send(method, params) {
        sent.push({ method, ...(params ? { params } : {}) });
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: top,
              childFrames: (options.frames ?? []).slice(1).map((frame) => ({ frame })),
            },
          };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "Runtime.callFunctionOn")
          return { result: { value: options.pageAnswer ?? "filled" } };
        return {};
      },
      close() {},
    }),
  };
  return { deps, sent };
}

const input = {
  tabId: "tab-1",
  origin: "https://console.example.test",
  username: USER,
  password: PASSWORD,
};

describe("the fill command over CDP", () => {
  it("sends the value only as call arguments and answers a status", async () => {
    const { deps, sent } = cdp();
    expect(await vaultFill(input, deps)).toEqual({ status: "filled" });
    const call = sent.find((s) => s.method === "Runtime.callFunctionOn");
    expect(String(call?.params?.functionDeclaration)).not.toContain(PASSWORD);
    expect(JSON.stringify(call?.params?.arguments)).toContain(PASSWORD);
    expect(call?.params?.executionContextId).toBe(7);
    expect(sent.find((s) => s.method === "Page.createIsolatedWorld")?.params?.frameId).toBe("f0");
    expect(sent.map((s) => s.method)).not.toContain("Page.navigate");
  });

  it("refuses a missing tab, another origin, an unknown or foreign frame before the page", async () => {
    expect(await vaultFill({ ...input, tabId: "tab-9" }, cdp().deps)).toEqual({
      status: "stale_tab",
    });
    const elsewhere = cdp({ targetUrl: "https://evil.example.test/login" });
    expect(await vaultFill(input, elsewhere.deps)).toEqual({ status: "target_mismatch" });
    const frames = [
      { id: "f0", url: "https://console.example.test/login" },
      { id: "f1", url: "https://sso.example.test/frame" },
    ];
    const foreign = cdp({ frames });
    expect(
      await vaultFill({ ...input, frameUrl: "https://sso.example.test/frame" }, foreign.deps),
    ).toEqual({
      status: "frame_mismatch",
    });
    expect(
      await vaultFill({ ...input, frameUrl: "https://console.example.test/x" }, foreign.deps),
    ).toEqual({ status: "missing_fields" });
    for (const c of [elsewhere, foreign])
      expect(c.sent.map((s) => s.method)).not.toContain("Runtime.callFunctionOn");
  });

  it("turns an answer it does not know into a failed fill", async () => {
    expect(await vaultFill(input, cdp({ pageAnswer: "signed_in" }).deps)).toEqual({
      status: "fill_failed",
    });
  });

  it("refuses an unusable stdin message and never prints a value", async () => {
    expect(parseVaultFillInput("not json")).toBeUndefined();
    expect(parseVaultFillInput(JSON.stringify({ ...input, password: "" }))).toBeUndefined();
    expect(parseVaultFillInput(JSON.stringify({ ...input, tabId: 5 }))).toBeUndefined();
    const out = await vaultFillCommand(JSON.stringify(input), cdp().deps);
    expect(JSON.stringify(out)).toBe('{"status":"filled"}');
    expect(await vaultFillCommand("{}", cdp().deps)).toEqual({ status: "fill_failed" });
  });
});
