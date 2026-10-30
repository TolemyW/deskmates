// @vitest-environment node
// Tabs are owned by UI: feature code supplies labels/state, never a competing geometry policy.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
const root = fileURLToPath(new URL("./", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
it("keeps page tab semantics and geometry in the shared components", () => {
  for (const path of files(root).filter((path) => !path.includes(".test."))) {
    const source = readFileSync(path, "utf8");
    if (path.endsWith(".css")) {
      expect(source, path).not.toMatch(
        /\.gb-(?:section-tabs|tab-(?:scroll|list|item|icon)|choice-(?:group|item|icon))\b/,
      );
    }
    if (path.endsWith(".css") || path.endsWith(".tsx"))
      expect(source, `${path}: use ChoiceGroup`).not.toMatch(
        /\b(?:app-tabs|period-picker|files-type-filter|files-view-toggle)\b/,
      );
    if (!path.endsWith(".tsx")) continue;
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(ast) === "role" &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        expect(["tab", "tablist"].includes(node.initializer.text), `${path}: use SectionTabs`).toBe(
          false,
        );
      }
      if (ts.isImportSpecifier(node))
        expect(node.name.text, `${path}: use SectionTabs or TabNavigation`).not.toBe("Tabs");
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});
