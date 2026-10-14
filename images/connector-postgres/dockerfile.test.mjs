// The connector image is assembled from explicit COPY lines and its own dockerignore allowlist.
// A package.json the deps stage lacks makes `npm ci` refuse the lockfile, a path the allowlist
// does not admit fails only at build time, and a wrong entrypoint or a missing migrations
// directory only when the container starts. Check all of that without Docker.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = new URL("./", import.meta.url);
const root = new URL("../../", import.meta.url);
const read = (name) => readFileSync(new URL(name, here), "utf8");
const dockerfile = read("Dockerfile");
const ignore = read("Dockerfile.dockerignore");

const copies = [...dockerfile.matchAll(/^COPY (?!--from)(.+)$/gm)].map((m) => {
  const parts = m[1]
    .trim()
    .split(/\s+/)
    .filter((part) => !part.startsWith("--"));
  return { sources: parts.slice(0, -1), dest: parts[parts.length - 1] };
});
const sources = copies.flatMap((c) => c.sources);

const allow = ignore
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("!"))
  .map((l) => l.slice(1).replace(/\/$/, ""));

function admitted(path) {
  return allow.some((pattern) => {
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}(/|$)`,
    );
    return re.test(path);
  });
}

describe("images/connector-postgres/Dockerfile", () => {
  it("copies every workspace package.json so npm ci sees the lockfile in sync", () => {
    // Every directory the root `workspaces` names: `packages/*` and explicit nested packages.
    const { workspaces } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const dirs = workspaces.flatMap((pattern) =>
      pattern.endsWith("/*")
        ? readdirSync(new URL(`${pattern.slice(0, -1)}`, root)).map(
            (name) => `${pattern.slice(0, -1)}${name}`,
          )
        : [pattern],
    );
    const packages = dirs.filter((dir) => {
      try {
        return statSync(new URL(`${dir}/package.json`, root)).isFile();
      } catch {
        return false;
      }
    });
    expect(packages).toContain("packages/channels/deskmates-agent-mcp");
    const copied = sources.filter((s) => /^packages\/.+\/package\.json$/.test(s));
    for (const dir of packages) expect(copied).toContain(`${dir}/package.json`);
  });

  it("copies only paths its dockerignore admits", () => {
    expect(sources.filter((s) => !admitted(s))).toEqual([]);
  });

  it("starts the package's bin and ships the migrations next to dist", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("packages/connector-postgres/package.json", root), "utf8"),
    );
    const bin = pkg.bin["deskmates-connector-postgres"].replace(/^\.\//, "");
    expect(dockerfile).toContain(
      `ENTRYPOINT ["node", "/opt/deskmates/packages/connector-postgres/${bin}"]`,
    );
    // open-receipts-db resolves the migrations as ../../migrations from dist/db/.
    const opener = readFileSync(
      new URL("packages/connector-postgres/src/db/open-receipts-db.ts", root),
      "utf8",
    );
    expect(opener).toContain('new URL("../../migrations/", import.meta.url)');
    expect(sources).toContain("packages/connector-postgres/migrations");
    expect(sources).toContain("packages/connector-postgres/dist");
    expect(sources).toContain("packages/contracts/dist");
  });

  it("runs as an unprivileged user from a node:22-bookworm-slim base", () => {
    expect([...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1])).toEqual([
      "node:22-bookworm-slim",
      "node:22-bookworm-slim",
    ]);
    const users = [...dockerfile.matchAll(/^USER (\S+)/gm)].map((m) => m[1]);
    expect(users).toEqual(["node"]);
  });
});
