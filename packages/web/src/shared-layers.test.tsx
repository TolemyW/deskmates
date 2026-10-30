// @vitest-environment jsdom
// T1: shared code sits below the features (README "Source layout"). `src/state/`,
// `src/components/` and `src/lib/` import nothing from `src/features/`: a part several screens
// use lives in `components/`, and a feature's part the shell shows is passed in by the shell, as
// the new-workspace dialog is to the workspace scope (#63 L25).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { installFakeEventSource, workspace } from "./test-support/fixtures.js";

const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * Feature specifiers a source names in a static `from`, a side-effect `import "…"` or a dynamic
 * `import("…")` (#63).
 */
function featureImports(source: string): string[] {
  return [
    ...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*(["'`])((?:\.\.\/)+features\/[^"'`]+)\1/g),
  ].map((match) => match[2] as string);
}

it("finds every form of a feature import", () => {
  const fixture = [
    'import { Files } from "../features/files/feature.js";',
    'import type { Chat } from "../../features/chat/api.js";',
    'export { Board } from "../features/board/feature.js";',
    'import "../features/files/files.css";',
    "import '../features/account/account.css';",
    'const lazy = () => import("../features/costs/feature.js");',
    "const later = import(`../features/tasks/feature.js`);",
    'import { ok } from "./features/not-shared.js";',
    'const text = "see features/files for details";',
  ].join("\n");
  expect(featureImports(fixture)).toEqual([
    "../features/files/feature.js",
    "../../features/chat/api.js",
    "../features/board/feature.js",
    "../features/files/files.css",
    "../features/account/account.css",
    "../features/costs/feature.js",
    "../features/tasks/feature.js",
  ]);
});

it("keeps state, components and lib free of feature imports", () => {
  const offenders = ["state", "components", "lib"].flatMap((dir) =>
    sources(join(SRC, dir)).flatMap((file) =>
      featureImports(readFileSync(file, "utf8")).map(
        (specifier) => `${relative(SRC, file)}: ${specifier}`,
      ),
    ),
  );
  expect(offenders).toEqual([]);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // Not the chat list: with no chats it opens the New chat dialog over the page.
  window.location.hash = "#/costs";
  installFakeEventSource();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/auth/session")
        return json({
          authenticated: true,
          user: { id: "usr_1", displayName: "Olive Owner", loginName: "olive" },
          tenant: { id: "tnt_default", name: "Default Tenant", role: "owner" },
          session: {
            authenticatedAt: "2026-10-05T00:00:00.000Z",
            idleExpiresAt: "2026-10-12T00:00:00.000Z",
            absoluteExpiresAt: "2026-11-04T00:00:00.000Z",
          },
          csrfToken: "session-csrf-1",
        });
      if (path === "/api/config") return json({ release: null });
      if (path.startsWith("/api/workspaces/directory"))
        return json({ workspaces: [], offset: 0, limit: 5, total: 0 });
      if (path.startsWith("/api/workspaces")) return json({ workspaces: [workspace] });
      if (path.startsWith("/api/bots")) return json({ bots: [] });
      if (path.startsWith("/api/threads")) return json({ threads: [] });
      if (path.startsWith("/api/members")) return json({ members: [] });
      if (path.startsWith("/api/invitations")) return json({ invitations: [] });
      return json({ approvals: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("still opens the new-workspace dialog from the switcher, now passed in by the shell", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: `Workspace: ${workspace.name}` }));
  const menu = await screen.findByRole("menu", { name: "Workspaces" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "New workspace" }));
  expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeTruthy();
});
