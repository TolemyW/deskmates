// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
const root = fileURLToPath(new URL("../features/", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
it("requires owned Select for new dropdowns and records legacy debt by feature", () => {
  for (const feature of readdirSync(root)) {
    const dir = join(root, feature);
    let allowed: Record<string, number> = {};
    try {
      const debt = JSON.parse(readFileSync(join(dir, "design-exceptions.json"), "utf8"));
      expect(debt.reason?.length).toBeGreaterThan(20);
      allowed = debt.nativeSelects;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const actual: Record<string, number> = {};
    for (const path of files(dir).filter((p) => p.endsWith(".tsx") && !p.includes(".test."))) {
      const ast = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      let count = 0;
      function visit(node: ts.Node) {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(ast) === "select"
        )
          count++;
        ts.forEachChild(node, visit);
      }
      visit(ast);
      if (count) actual[relative(dir, path)] = count;
    }
    expect(
      actual,
      `${feature}: use @deskmates/ui Select; remove resolved exceptions, do not expand this baseline`,
    ).toEqual(allowed);
  }
});
