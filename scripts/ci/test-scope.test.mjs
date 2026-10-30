import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardTestPaths } from "./test-guards.mjs";
import { chooseTestScope, findReaders, readChangedFiles } from "./test-scope.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CI affected scope", () => {
  it.each([
    "docs/design/cost-proposal.md",
    "docs/runbooks/ci-test-performance.md",
    "docs/releases/v1.md",
    "docs/adr/0001-example.md",
    "README.md",
    "packages/sidecar/README.md",
  ])("keeps prose on a checked fast path: %s", (file) => {
    expect(chooseTestScope([file])).toMatchObject({
      mode: "docs",
      typecheck: false,
      webBuild: false,
    });
    expect(chooseTestScope([file]).guards).toContain("scripts/docs-consistency.test.mjs");
    expect(chooseTestScope([file]).guards).toContain("packages/sidecar/src/approval-docs.test.ts");
  });
  it("uses the import graph for source, tests and mixed prose/source changes", () => {
    for (const files of [
      ["packages/gateway/src/threads/router.ts"],
      ["packages/web/src/features/chats/chat-pane.test.tsx"],
      ["docs/design/proposal.md", "packages/sidecar/src/context.ts"],
      ["packages/contracts/src/task.ts"],
      ["packages/testkit/src/fake.ts"],
    ])
      expect(chooseTestScope(files)).toMatchObject({
        mode: "affected",
        typecheck: true,
      });
  });
  it("runs script/workflow text readers without expanding to every product test", () => {
    for (const file of [
      "scripts/ci/test-scope.mjs",
      "scripts/stable/stable.sh",
      ".github/workflows/ci.yml",
    ])
      expect(chooseTestScope([file])).toMatchObject({
        mode: "affected",
        guards: expect.arrayContaining(["scripts/"]),
      });
  });
  it.each([
    "packages/gateway/migrations/202610261200-example.sql",
    "packages/gateway/src/api/route-policies/threads.ts",
    "packages/web/src/features/chats/messages/en.json",
    "packages/web/src/features/chats/__golden__/api.json",
    "packages/web/src/features/chats/__snapshots__/view.snap",
    "packages/sidecar/src/fixtures/response.txt",
    "packages/sidecar/src/context.md",
    "packages/gateway/package.json",
  ])("covers the owning package for a non-imported input: %s", (file) => {
    const plan = chooseTestScope([file]);
    expect(plan.mode).toBe("affected");
    expect(plan.guards).toContain(`${file.split("/").slice(0, 2).join("/")}/`);
  });
  it("builds the Web only for UI inputs or a full fallback", () => {
    expect(chooseTestScope(["packages/gateway/src/threads/router.ts"]).webBuild).toBe(false);
    expect(chooseTestScope(["scripts/ci/test-scope.mjs"]).webBuild).toBe(false);
    expect(chooseTestScope(["packages/web/src/features/chats/chat-pane.tsx"]).webBuild).toBe(true);
    expect(chooseTestScope(["packages/ui/src/button.tsx"]).webBuild).toBe(true);
    expect(chooseTestScope(["package-lock.json"]).webBuild).toBe(true);
    expect(chooseTestScope(["packages/contracts/src/task.test.ts"]).mode).toBe("affected");
  });
  it("keeps guard arguments as validated argv and rejects missing or hostile filters", () => {
    expect(guardTestPaths('["scripts/", "packages/web/", "images/egress/"]')).toEqual([
      "scripts/",
      "packages/web/",
      "images/egress/",
    ]);
    for (const value of [
      undefined,
      "bad-json",
      "null",
      "[]",
      '["--passWithNoTests"]',
      '["scripts/../secret"]',
      '["scripts/;echo"]',
      '["docs/"]',
      "[5]",
    ])
      expect(() => guardTestPaths(value)).toThrow();
  });
  it("treats bundled guide pages as UI input with UI tests and a build", () => {
    expect(chooseTestScope(["docs/guide/chats-and-groups.md"])).toMatchObject({
      mode: "affected",
      webBuild: true,
      guards: expect.arrayContaining(["packages/web/"]),
    });
  });
  it.each(["package-lock.json", "package.json", "tsconfig.base.json", "vitest.config.ts"])(
    "runs the full suite only for the root toolchain: %s",
    (file) => {
      expect(chooseTestScope([file]).mode).toBe("full");
    },
  );
  it.each([
    "packages/contracts/src/task.ts",
    "packages/testkit/src/fake.ts",
    "packages/channels/deskmates-agent-mcp/package.json",
    "biome.json",
    "docs/generated/permission-matrix.md",
    "images/workspace-base/Dockerfile",
    "observability/grafana/dashboard.json",
    ".env.example",
    "new-unclassified-input.data",
  ])("never falls back to the full suite for a scoped input: %s", (file) => {
    const plan = chooseTestScope([file]);
    expect(plan.mode).not.toBe("full");
    // The public scan runs on its own or as part of a scripts/ guard.
    expect(
      plan.guards.some((guard) => ["scripts/public-scan.test.mjs", "scripts/"].includes(guard)),
    ).toBe(true);
  });
  it("runs a changed image's own tests and the code that builds it, not the product suite", () => {
    const plan = chooseTestScope(["images/workspace-base/Dockerfile"]);
    expect(plan).toMatchObject({ mode: "affected", typecheck: false, webBuild: false });
    expect(plan.guards).toEqual(
      expect.arrayContaining(["images/workspace-base/", "packages/sandbox-docker/", "scripts/"]),
    );
    expect(plan.guards).not.toContain("packages/gateway/");
    expect(chooseTestScope(["images/egress/egress-proxy.mjs"]).guards).toContain("images/egress/");
  });
  it("runs the owner tests of generated documentation", () => {
    expect(chooseTestScope(["docs/generated/permission-matrix.md"]).guards).toContain(
      "packages/gateway/src/api/permission-matrix.test.ts",
    );
  });
  it("adds every test that names a changed path, without repeating one a directory covers", () => {
    const readers = () => [
      "packages/gateway/src/config/env-example.test.ts",
      "scripts/stable/stable.test.mjs",
    ];
    const plan = chooseTestScope([".env.example"], "pull_request", readers);
    expect(plan.guards).toContain("packages/gateway/src/config/env-example.test.ts");
    const scripts = chooseTestScope(["scripts/stable/stable.sh"], "pull_request", readers);
    expect(scripts.guards).toContain("scripts/");
    expect(scripts.guards).not.toContain("scripts/stable/stable.test.mjs");
  });
  it("looks readers up with git grep over unit tests and treats no match as none", () => {
    const calls = [];
    const listing = [
      "packages/sandbox-docker/src/build-workspace-image.test.ts",
      "acceptance/m0-stack.container.test.ts",
      "",
    ].join("\n");
    const found = findReaders(["images/workspace-base/Dockerfile"], (_command, args) => {
      calls.push(args);
      return listing;
    });
    expect(found).toEqual(["packages/sandbox-docker/src/build-workspace-image.test.ts"]);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "grep",
        "-l",
        "-F",
        "images/workspace-base/Dockerfile",
        "images/workspace-base",
      ]),
    );
    // A top-level directory alone is not used as a search term.
    expect(calls[0]).not.toContain("images");
    const none = Object.assign(new Error("no match"), { status: 1 });
    expect(
      findReaders(["x/y/z.txt"], () => {
        throw none;
      }),
    ).toEqual([]);
    expect(() =>
      findReaders(["x/y/z.txt"], () => {
        throw Object.assign(new Error("broken"), { status: 128 });
      }),
    ).toThrow("broken");
  });
  it("finds a real reader of a text input in this repository", () => {
    expect(findReaders(["docs/generated/permission-matrix.md"])).toContain(
      "packages/gateway/src/api/permission-matrix.test.ts",
    );
  });
  it("fails closed for manual runs and reusable workflows, and runs only guards for an empty diff", () => {
    expect(chooseTestScope([])).toMatchObject({ mode: "affected", typecheck: false });
    for (const event of ["workflow_dispatch", "workflow_call", "push"])
      expect(chooseTestScope(["docs/design/proposal.md"], event).mode).toBe("full");
  });
  it("always keeps mirror and hotspot checks, with unique guard paths", () => {
    const plan = chooseTestScope(["scripts/ci/test-scope.mjs", ".github/workflows/ci.yml"]);
    expect(plan.guards).toEqual([...new Set(plan.guards)].sort());
    expect(plan.guards).toContain("scripts/");
    // The public scan and hotspot budgets live under scripts/, which already runs them.
    expect(chooseTestScope(["packages/gateway/src/threads/router.ts"]).guards).toEqual(
      expect.arrayContaining(["scripts/public-scan.test.mjs", "scripts/hotspot-budgets.test.mjs"]),
    );
  });
  it("includes a removed toolchain input when git reports a rename", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
    roots.push(root);
    const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.name", "Scope test"]);
    git(["config", "user.email", "scope@example.invalid"]);
    writeFileSync(join(root, "package-lock.json"), "fixture\n");
    git(["add", "."]);
    git(["commit", "-qm", "baseline"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    git(["mv", "package-lock.json", "renamed.data"]);
    git(["commit", "-qm", "rename"]);
    const files = readChangedFiles(base, (_command, args) => git(args));
    expect(files.sort()).toEqual(["package-lock.json", "renamed.data"]);
    expect(chooseTestScope(files).mode).toBe("full");
  });
  it("rejects a missing or moving base instead of passing an untrusted git option", () => {
    for (const base of [undefined, "main", "--output=bad"])
      expect(() => readChangedFiles(base)).toThrow("pinned PR base");
  });
});
