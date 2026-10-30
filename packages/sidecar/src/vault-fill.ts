// `deskmates-sidecar vault-fill` (ADR-0045 decision 5): the fixed command the Gateway runs through
// the sandbox provider to fill a Vault browser login. The request, the value included, arrives on
// stdin; nothing of it is an argument, an environment variable or a file, and nothing of it is
// printed. The answer is one line `{"status": ...}`.
//
// The command attaches to the workspace's one Chromium over CDP, finds the run's tab by its target
// id, and rechecks, inside the frame and immediately before filling, that the top-level page and
// the frame are both on the entry's exact origin and that the page has not navigated. It fills a
// password only into a password input, never submits, never navigates, and reads nothing back.
// It is execution plumbing, not another agent and not a browser per bot.
//
// What it cannot change (decision 9): the filled value is now in the shared browser, where page
// scripts and any code in the workspace with CDP or shell access can read it.

import {
  VAULT_VALUE_MAX,
  type VaultFillCommandInput,
  type VaultFillCommandOutput,
  type VaultFillStatus,
} from "@deskmates/contracts";

export const DEFAULT_VAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

const STATUSES: ReadonlySet<string> = new Set<VaultFillStatus>([
  "filled",
  "target_mismatch",
  "frame_mismatch",
  "stale_tab",
  "missing_fields",
  "ambiguous_fields",
  "not_password_field",
  "navigated",
  "fill_failed",
]);

/**
 * Runs inside the frame, in an isolated world, as one function call: no closure, no import. It
 * returns a status and never a value. Plain JavaScript source, because it runs in the page and
 * this package has no DOM types; exported so a T0 test can run it against a DOM.
 *
 * Arguments: expected origin, the frame URL read just before, username selector, password
 * selector (empty: find the one visible password input and the text field before it), username
 * (empty: fill only the password), password.
 */
export const VAULT_FILL_PAGE_FUNCTION = `function (expectedOrigin, startHref, usernameSelector, passwordSelector, username, password) {
  try {
    if (location.origin !== expectedOrigin) return "frame_mismatch";
    var topOrigin;
    try {
      topOrigin = (window.top || window).location.origin;
    } catch (e) {
      return "target_mismatch";
    }
    if (topOrigin !== expectedOrigin) return "target_mismatch";
    if (location.href !== startHref) return "navigated";
    var visible = function (el) {
      if (el.getClientRects().length === 0) return false;
      var style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    var select = function (selector) {
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch (e) {
        return undefined;
      }
    };
    var passwordField;
    if (passwordSelector !== "") {
      var named = select(passwordSelector);
      if (!named || named.length === 0) return "missing_fields";
      if (named.length > 1) return "ambiguous_fields";
      passwordField = named[0];
    } else {
      var found = Array.from(document.querySelectorAll("input")).filter(function (el) {
        return String(el.type).toLowerCase() === "password" && visible(el);
      });
      if (found.length === 0) return "missing_fields";
      if (found.length > 1) return "ambiguous_fields";
      passwordField = found[0];
    }
    if (!(passwordField instanceof HTMLInputElement) || String(passwordField.type).toLowerCase() !== "password")
      return "not_password_field";
    if (passwordField.disabled || passwordField.readOnly) return "missing_fields";
    var textLike = function (el) {
      return el instanceof HTMLInputElement &&
        ["text", "email", "tel"].indexOf(String(el.type).toLowerCase()) >= 0 &&
        !el.disabled && !el.readOnly;
    };
    var usernameField;
    if (username !== "") {
      if (usernameSelector !== "") {
        var users = select(usernameSelector);
        if (!users || users.length === 0) return "missing_fields";
        if (users.length > 1) return "ambiguous_fields";
        if (!textLike(users[0])) return "missing_fields";
        usernameField = users[0];
      } else {
        var scope = passwordField.form || document;
        var before = Array.from(scope.querySelectorAll("input")).filter(function (el) {
          return textLike(el) && visible(el) &&
            (el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        });
        if (before.length === 0) return "missing_fields";
        usernameField = before[before.length - 1];
      }
    }
    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    var setValue = descriptor && descriptor.set;
    if (!setValue) return "fill_failed";
    var put = function (el, value) {
      el.focus();
      setValue.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (usernameField) put(usernameField, username);
    put(passwordField, password);
    passwordField.blur();
    return "filled";
  } catch (e) {
    return "fill_failed";
  }
}`;

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpFrame {
  id: string;
  url: string;
}

interface CdpFrameTree {
  frame: CdpFrame;
  childFrames?: CdpFrameTree[];
}

/** One CDP connection to a page target. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export interface VaultFillDeps {
  listTargets(): Promise<CdpTarget[]>;
  connect(webSocketUrl: string): Promise<CdpSession>;
}

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function frames(tree: CdpFrameTree): CdpFrame[] {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap(frames)];
}

/** The stdin message, checked; undefined when it is not a usable request. Never echoed. */
export function parseVaultFillInput(text: string): VaultFillCommandInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const str = (key: string, max: number, required: boolean): string | undefined | null => {
    const field = v[key];
    if (field === undefined || field === "") return required ? null : undefined;
    return typeof field === "string" && field.length <= max ? field : null;
  };
  const tabId = str("tabId", 200, true);
  const origin = str("origin", 300, true);
  const frameUrl = str("frameUrl", 2000, false);
  const usernameField = str("usernameField", 300, false);
  const passwordField = str("passwordField", 300, false);
  const username = typeof v.username === "string" ? v.username : null;
  const password = str("password", VAULT_VALUE_MAX, true);
  if (
    !tabId ||
    !origin ||
    frameUrl === null ||
    usernameField === null ||
    passwordField === null ||
    username === null ||
    username.length > VAULT_VALUE_MAX ||
    !password
  )
    return undefined;
  return {
    tabId,
    origin,
    ...(frameUrl ? { frameUrl } : {}),
    ...(usernameField ? { usernameField } : {}),
    ...(passwordField ? { passwordField } : {}),
    username,
    password,
  };
}

/** Fill once; every path answers a status and none of them a value. */
export async function vaultFill(
  input: VaultFillCommandInput,
  deps: VaultFillDeps,
): Promise<VaultFillCommandOutput> {
  let targets: CdpTarget[];
  try {
    targets = await deps.listTargets();
  } catch {
    return { status: "fill_failed" };
  }
  const target = targets.find((t) => t.id === input.tabId && t.type === "page");
  if (!target?.webSocketDebuggerUrl) return { status: "stale_tab" };
  if (originOf(target.url) !== input.origin) return { status: "target_mismatch" };
  let session: CdpSession;
  try {
    session = await deps.connect(target.webSocketDebuggerUrl);
  } catch {
    return { status: "fill_failed" };
  }
  try {
    const { frameTree } = (await session.send("Page.getFrameTree")) as {
      frameTree?: CdpFrameTree;
    };
    if (!frameTree) return { status: "fill_failed" };
    if (originOf(frameTree.frame.url) !== input.origin) return { status: "target_mismatch" };
    const frame = input.frameUrl
      ? frames(frameTree).find((f) => f.url === input.frameUrl)
      : frameTree.frame;
    if (!frame) return { status: "missing_fields" };
    if (originOf(frame.url) !== input.origin) return { status: "frame_mismatch" };
    const world = (await session.send("Page.createIsolatedWorld", {
      frameId: frame.id,
      worldName: "deskmates-vault",
      grantUniveralAccess: false,
    })) as { executionContextId?: number };
    if (typeof world.executionContextId !== "number") return { status: "fill_failed" };
    const answer = (await session.send("Runtime.callFunctionOn", {
      functionDeclaration: VAULT_FILL_PAGE_FUNCTION,
      executionContextId: world.executionContextId,
      arguments: [
        { value: input.origin },
        { value: frame.url },
        { value: input.usernameField ?? "" },
        { value: input.passwordField ?? "" },
        { value: input.username },
        { value: input.password },
      ],
      returnByValue: true,
      awaitPromise: false,
      silent: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    const status = answer.result?.value;
    if (
      answer.exceptionDetails !== undefined ||
      typeof status !== "string" ||
      !STATUSES.has(status)
    )
      return { status: "fill_failed" };
    return { status: status as VaultFillStatus };
  } catch {
    return { status: "fill_failed" };
  } finally {
    session.close();
  }
}

/** The real CDP side: the HTTP target list and one WebSocket per call. */
export function cdpFillDeps(endpoint: string, timeoutMs = 10_000): VaultFillDeps {
  return {
    async listTargets() {
      const res = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
      return (await res.json()) as CdpTarget[];
    },
    connect(webSocketUrl) {
      const Socket = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
      if (!Socket) return Promise.reject(new Error("no WebSocket"));
      const socket = new Socket(webSocketUrl);
      const pending = new Map<number, (message: Record<string, unknown>) => void>();
      let next = 0;
      socket.onmessage = (event) => {
        let message: { id?: number } & Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof message.id === "number") pending.get(message.id)?.(message);
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CDP connect timed out")), timeoutMs);
        socket.onerror = () => reject(new Error("CDP connection failed"));
        socket.onopen = () => {
          clearTimeout(timer);
          resolve({
            send(method, params = {}) {
              const id = ++next;
              return new Promise((done, fail) => {
                const deadline = setTimeout(() => {
                  pending.delete(id);
                  fail(new Error("CDP call timed out"));
                }, timeoutMs);
                pending.set(id, (message) => {
                  clearTimeout(deadline);
                  pending.delete(id);
                  if (message.error) fail(new Error("CDP error"));
                  else done((message.result ?? {}) as Record<string, unknown>);
                });
                socket.send(JSON.stringify({ id, method, params }));
              });
            },
            close() {
              socket.close();
            },
          });
        };
      });
    },
  };
}

interface WebSocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onopen: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** The subcommand: stdin in, one status line out, exit 0 whenever a status was answered. */
export async function vaultFillCommand(
  stdin: string,
  deps: VaultFillDeps,
): Promise<VaultFillCommandOutput> {
  const input = parseVaultFillInput(stdin);
  if (!input) return { status: "fill_failed" };
  return vaultFill(input, deps);
}
