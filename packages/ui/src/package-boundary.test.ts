// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path) && !path.includes(".test.")
        ? [path]
        : [];
  });
}
function imports(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const result: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) result.push(arg.text);
      else throw new Error(`Uninspectable import in ${path}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

describe("ADR-0025 UI package boundary", () => {
  it("has no Deskmates dependencies or imports outside its own source", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const allowed = new Set([
      ...Object.keys(pkg.dependencies),
      ...Object.keys(pkg.peerDependencies),
    ]);
    expect([...allowed].filter((name) => name.startsWith("@deskmates/"))).toEqual([]);
    for (const file of files(join(root, "src")))
      for (const spec of imports(file)) {
        const valid = spec.startsWith(".")
          ? resolve(dirname(file), spec).startsWith(`${join(root, "src")}/`)
          : allowed.has(spec);
        expect(valid, `${file} imports ${spec}`).toBe(true);
      }
  });
  it("keeps HeroUI out of consumer code and application packages out of the studio", () => {
    for (const file of files(resolve(root, "../web/src")))
      for (const spec of imports(file)) {
        expect(spec.startsWith("@heroui/"), `${file}: use @deskmates/ui`).toBe(false);
      }
    for (const file of files(join(root, "studio")))
      for (const spec of imports(file)) {
        if (spec.startsWith("."))
          expect(resolve(dirname(file), spec).startsWith(root), file).toBe(true);
        else expect(spec.startsWith("@deskmates/"), file).toBe(false);
      }
  });
});

describe("native HeroUI appearance", () => {
  it("keeps upstream visual tokens and primitive styles intact", () => {
    const css = readFileSync(join(root, "src/styles.css"), "utf8");
    expect(css).not.toMatch(
      /--(?:accent|surface|foreground|background|radius|field-radius|border|field-border-width)\s*:/,
    );
    for (const selector of ["gb-button", "gb-input", "gb-card", "gb-pill"]) {
      const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`));
      expect(rule?.[1] ?? "", selector).not.toMatch(
        /(?:border-radius|box-shadow|font-size|font-weight|background|color)\s*:/,
      );
    }
    const legacy = readFileSync(resolve(root, "../web/src/app.css"), "utf8");
    expect(legacy).not.toMatch(/--(?:surface|radius|border|success|warning|danger|text-sm)\s*:/);
  });
});
