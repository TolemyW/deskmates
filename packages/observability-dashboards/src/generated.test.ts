// T0 (ADR-0046 decision 7): the committed files under observability/grafana/ are exactly what the
// generator writes for every engine, and nothing else is there. After changing the spec, a
// dialect or an engine, regenerate from the repository root with
// `UPDATE_GENERATED=1 npx vitest run packages/observability-dashboards/src/generated.test.ts`.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OUTPUT_ROOT, REFRESH_COMMAND, generatedFiles } from "./generate.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function committed(): string[] {
  const root = join(REPO, OUTPUT_ROOT);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(REPO, path).split(sep).join("/"));
    }
  };
  walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

describe("generated Grafana provisioning", () => {
  const files = generatedFiles();

  it("is committed exactly as the generator writes it", () => {
    if (process.env.UPDATE_GENERATED === "1") {
      rmSync(join(REPO, OUTPUT_ROOT), { recursive: true, force: true });
      for (const file of files) {
        mkdirSync(dirname(join(REPO, file.path)), { recursive: true });
        writeFileSync(join(REPO, file.path), file.content);
      }
      return;
    }
    const stale = `${OUTPUT_ROOT} is out of date; regenerate it with \`${REFRESH_COMMAND}\``;
    expect(committed(), stale).toEqual(files.map((file) => file.path));
    for (const file of files)
      expect(readFileSync(join(REPO, file.path), "utf8"), `${file.path}: ${stale}`).toBe(
        file.content,
      );
  });

  it("writes the same output twice", () => {
    expect(generatedFiles()).toEqual(files);
  });

  it("gives every dashboard of an engine a distinct uid and panel ids", () => {
    const dashboards = files
      .filter((file) => file.path.endsWith(".json"))
      .map((file) => JSON.parse(file.content) as { uid: string; panels: { id: number }[] });
    const byEngine = new Map<string, string[]>();
    for (const [index, file] of files.filter((f) => f.path.endsWith(".json")).entries()) {
      const engine = file.path.split("/")[2] as string;
      const dashboard = dashboards[index] as { uid: string; panels: { id: number }[] };
      byEngine.set(engine, [...(byEngine.get(engine) ?? []), dashboard.uid]);
      const ids = dashboard.panels.map((panel) => panel.id);
      expect(new Set(ids).size, file.path).toBe(ids.length);
    }
    for (const [engine, uids] of byEngine) expect(new Set(uids).size, engine).toBe(uids.length);
  });
});
