// @vitest-environment node
// T0: the operator UI reads its words from the message catalog (issue #23, decision 3). This scan
// fails on a hard-coded literal with letters in JSX text, in a JSX expression that renders a
// string, in an `aria-label`, `placeholder`, `title` or `alt` attribute, or in a `confirm()`
// dialog. Proper nouns that are the same in every language (Deskmates, WhatsApp, noVNC, …) are in
// `literal-allowlist.json`. Bot, thread and task content comes from the Gateway, not from source,
// so it never shows up here.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import allowlist from "./literal-allowlist.json";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Attributes whose value a person reads or hears. */
const CHECKED_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "placeholder",
  "title",
  "alt",
]);

/** Source that is not the operator UI: tests, the in-browser mock Gateway's sample data. */
function scanned(path: string): boolean {
  const rel = relative(SRC, path);
  return (
    rel.endsWith(".tsx") &&
    !rel.endsWith(".test.tsx") &&
    !rel.startsWith("demo/") &&
    !rel.startsWith("test-support/")
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : scanned(path) ? [path] : [];
  });
}

/** Longest terms first, so "Google Drive" goes before "Google". */
const TERMS = [...allowlist.terms].sort((a, b) => b.length - a.length);

/** Whether a literal has words left once the allowlisted terms are taken out. */
function hasWords(text: string): boolean {
  let rest = text;
  for (const term of TERMS) rest = rest.split(term).join(" ");
  return /\p{L}/u.test(rest);
}

/** The string pieces an expression can render as it stands: literals, not call arguments. */
function renderedLiterals(node: ts.Node, into: ts.Node[] = []): ts.Node[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) into.push(node);
  else if (ts.isTemplateExpression(node)) {
    into.push(node.head);
    for (const span of node.templateSpans) {
      into.push(span.literal);
      renderedLiterals(span.expression, into);
    }
  } else if (ts.isConditionalExpression(node)) {
    renderedLiterals(node.whenTrue, into);
    renderedLiterals(node.whenFalse, into);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    )
      renderedLiterals(node.right, into);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
      renderedLiterals(node.left, into);
    if (op === ts.SyntaxKind.PlusToken) {
      renderedLiterals(node.left, into);
      renderedLiterals(node.right, into);
    }
  } else if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    renderedLiterals(node.expression, into);
  return into;
}

function literalText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    return node.text;
  return node.getText();
}

function isConfirmCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "confirm";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "confirm" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "window"
  );
}

/** Every hard-coded literal with words in one file, as `path:line: "text"`. */
function findHardCodedLiterals(path: string, text = readFileSync(path, "utf8")): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, literal: string): void => {
    const trimmed = literal.replace(/\s+/g, " ").trim();
    if (!hasWords(trimmed)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push(`${relative(SRC, path)}:${line}: ${JSON.stringify(trimmed)}`);
  };
  const reportExpression = (expression: ts.Expression): void => {
    for (const literal of renderedLiterals(expression)) report(literal, literalText(literal));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, node.text);
    else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent))
      reportExpression(node.expression);
    else if (ts.isJsxAttribute(node) && CHECKED_ATTRIBUTES.has(node.name.getText(source))) {
      const value = node.initializer;
      if (value && ts.isStringLiteral(value)) report(value, value.text);
      else if (value && ts.isJsxExpression(value) && value.expression)
        reportExpression(value.expression);
    } else if (ts.isCallExpression(node) && isConfirmCall(node)) {
      for (const argument of node.arguments) reportExpression(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("hard-coded UI literals", () => {
  it("finds a literal in JSX text, attributes, rendered expressions and confirm dialogs", () => {
    const sample = [
      "export function S({ n }: { n: number }) {",
      '  if (confirm("Delete it?")) return null;',
      "  return (",
      '    <div title="Hello" aria-label={n ? "Many" : t("ok")} placeholder={`Type ${n}`}>',
      "      Plain words",
      '      {n > 1 && "Several"}',
      '      {t("key.that.is.fine")} {" · "} Deskmates',
      '      <img alt="" className="no words here" />',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const found = findHardCodedLiterals(join(SRC, "sample.tsx"), sample).map((entry) =>
      entry.replace(/^sample\.tsx:\d+: /, ""),
    );
    expect(found).toEqual([
      '"Delete it?"',
      '"Hello"',
      '"Many"',
      '"Type"',
      '"Plain words"',
      '"Several"',
    ]);
  });

  it("finds none in the operator UI", () => {
    const found = sourceFiles(SRC).flatMap((path) => findHardCodedLiterals(path));
    expect(found).toEqual([]);
  });
});
