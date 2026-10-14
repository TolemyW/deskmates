import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_DOCS,
  CURRENT_STATUS,
  PENDING_GATES,
  checkDocs,
  validateAdr,
  validateCurrentDocs,
  verificationIds,
} from "./docs-consistency.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const table = (rows) =>
  `## Verification\n\n| Item | Means | Test | Metric |\n|---|---|---|---|\n${rows}\n`;
const row = (id) => `| ${id} | a bounded invariant | T0 named test; pending | none |`;
const adr = (status = "Accepted", decisions = "1. One invariant.", rows = row("1")) =>
  `# ADR-9999: Example\n\nStatus: ${status}\n\n## Context\n\n1. Unrelated context list.\n\n` +
  `## Decision\n\n${decisions}\n\n## Alternatives\n\n42. Unrelated alternative.\n\n${table(rows)}`;
const currentDocuments = () =>
  Object.fromEntries(
    CURRENT_DOCS.map((path) => [
      path,
      `<!-- current-status:start -->\n${CURRENT_STATUS}\n<!-- current-status:end -->\nSee m4-status-2026-10-04.md\n${
        path === CURRENT_DOCS.at(-1)
          ? `<!-- acceptance-gates:start -->\n| Gate | State | Required evidence |\n|---|---|---|\n${PENDING_GATES.map((gate) => `| ${gate} | Pending | Actual evidence required |`).join("\n")}\n<!-- acceptance-gates:end -->`
          : ""
      }`,
    ]),
  );

const temporaryRoots = [];
afterEach(() => {
  for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "docs-consistency-"));
  temporaryRoots.push(dir);
  const put = (path, source) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  };
  for (const [path, source] of Object.entries(currentDocuments())) put(path, source);
  return { dir, put };
}

describe("ADR verification coverage", () => {
  it.each([
    "Accepted",
    "Proposed",
    "Accepted (owner, 2026-10-04)",
    "accepted for implementation by the owner; live acceptance pending",
    "Proposed (live verification not run)",
  ])("accepts the established qualified decision status %s", (status) => {
    expect(validateAdr(adr(status)).errors).toEqual([]);
  });

  it("rejects missing, duplicate or unknown top-level statuses", () => {
    expect(validateAdr(adr().replace("Status: Accepted", "")).errors).not.toEqual([]);
    expect(
      validateAdr(adr().replace("Status: Accepted", "Status: Accepted\nStatus: Proposed")).errors,
    ).not.toEqual([]);
    expect(validateAdr(adr("Passed")).errors).toContain('ADR: invalid ADR status "Passed"');
    expect(validateAdr(adr("Acceptedly complete")).errors).not.toEqual([]);
  });

  it("limits the implementation-status exception to the exact historical ADR", () => {
    const source = adr(
      "Implementation in progress (B4 activated 2026-09-23; amendments); acceptance pending",
    );
    expect(validateAdr(source, "0006-operator-api-auth-and-workspace-networks.md").errors).toEqual(
      [],
    );
    expect(validateAdr(source, "9999-other.md").errors).not.toEqual([]);
  });

  it("maps grouped rows and ranges by ID, not row count", () => {
    expect(validateAdr(adr("Accepted", "1. A\n2. B\n3. C", row("1, 2, 3"))).errors).toEqual([]);
    expect(validateAdr(adr("Accepted", "1. A\n2. B\n3. C", row("1–3 end to end"))).errors).toEqual(
      [],
    );
    const missing = validateAdr(adr("Accepted", "1. A\n2. B", `${row("1")}\n${row("1, detail")}`));
    expect(missing.errors).toContain("ADR: decision 2 has no complete Verification row");
  });

  it("supports separate amendment IDs and ignores unrelated lists and fenced examples", () => {
    const source = `${adr("Accepted", "1. A\n   1. A nested substep\n   1a. A subdecision", `${row("1")}\n${row("1a")}`)}\n## Amendment 1\n\nA1. An amended invariant\n\n### Verification\n\n${table(row("A1")).replace("## Verification\n", "")}\n\`\`\`md\n## Decision\n99. Example only\n\`\`\`\n## Context\n52. Not a decision\n`;
    expect(validateAdr(source).errors).toEqual([]);
    expect(validateAdr(source.replace(row("A1"), row("1"))).errors).toContain(
      "ADR: decision A1 has no complete Verification row",
    );
  });

  it("inherits Decision and Amendment scope through ordinary nested headings", () => {
    const source = adr().replace(
      "## Alternatives",
      "### Additional invariant\n\n2. Still a decision.\n\n#### Details\n\n3. Another decision.\n\n## Alternatives",
    );
    expect(validateAdr(source).errors).toEqual([
      "ADR: decision 2 has no complete Verification row",
      "ADR: decision 3 has no complete Verification row",
    ]);
    const amended = `${adr()}\n## Amendment 1\n\n### Details\n\nA1. An added invariant.\n\n### Alternatives\n\n99. Not a decision.\n\n### Verification\n\n${table(row("A1")).replace("## Verification\n", "")}\n## Context\n\n42. Outside the amendment.\n`;
    expect(validateAdr(amended).errors).toEqual([]);
    expect(validateAdr(amended.replace(row("A1"), row("1"))).errors).toContain(
      "ADR: decision A1 has no complete Verification row",
    );
  });

  it("does not allow empty cells or unknown IDs to count as proof coverage", () => {
    expect(validateAdr(adr("Accepted", "1. A", "| 1 | invariant | | none |")).errors).toContain(
      "ADR: decision 1 has no complete Verification row",
    );
    expect(validateAdr(adr("Accepted", "1. A", row("2"))).errors).toContain(
      "ADR: Verification references unknown decision 2",
    );
    expect(validateAdr(adr("Accepted", "1. A\n1. B")).errors.join("\n")).toMatch(
      /duplicate decision 1/,
    );
    expect(validateAdr(adr().replace("## Verification", "## Verification state")).errors).toContain(
      "ADR: missing Verification table",
    );
  });

  it("accepts header aliases and escaped pipes without claiming tests passed", () => {
    const source = adr("Proposed")
      .replace("## Decision", "## Decisions")
      .replace("| Item | Means | Test |", "| Decision | Concrete meaning | Executable proof |")
      .replace("a bounded invariant", "L0 \\| L1");
    expect(validateAdr(source).errors).toEqual([]);
  });

  it("rejects missing table separators and ignores commented-out proof", () => {
    const noSeparator = adr().replace("|---|---|---|---|\n", "");
    expect(validateAdr(noSeparator).errors.join("\n")).toMatch(/Markdown separator/);
    expect(validateAdr(adr().replace(row("1"), `<!-- ${row("1")} -->`)).errors).toContain(
      "ADR: decision 1 has no complete Verification row",
    );
  });

  it("parses only leading IDs and bounded ranges", () => {
    expect(verificationIds("2, resilience (added 2026-09-22)")).toEqual(["2"]);
    expect(verificationIds("A1–A3 (amendment 1)")).toEqual(["A1", "A2", "A3"]);
    expect(verificationIds("4a")).toEqual(["4a"]);
    expect(verificationIds("goal impact 5")).toEqual([]);
    expect(verificationIds("3–1")).toEqual([]);
    expect(verificationIds("1–1000000")).toEqual([]);
  });

  it.each([
    "9007199254740992-9007199254740993",
    "9007199254740991-9007199254740993",
    "A9007199254740992-A9007199254740993",
    "9007199254740992",
    "0",
    "A0",
    "0-2",
    "1-0",
    "1--2",
    "3-1",
    "1-1002",
  ])("rejects unsafe, nonpositive or out-of-bounds references %s", (label) => {
    expect(verificationIds(label)).toEqual([]);
  });

  it("exempts superseded proofs but checks the successor and reciprocal reference", () => {
    const { dir, put } = fixture();
    put("docs/adr/9998-old.md", "# Old\nStatus: Superseded by ADR-9999 on 2026-10-04\n");
    expect(checkDocs(dir).join("\n")).toMatch(/superseding ADR-9999 must exist/);
    put("docs/adr/9999-new.md", adr());
    expect(checkDocs(dir).join("\n")).toMatch(/must exist and name ADR-9998/);
    put("docs/adr/9999-new.md", `${adr()}\nSupersedes ADR-9998.\n`);
    expect(checkDocs(dir)).toEqual([]);
  });
});

describe("bounded current-status consistency", () => {
  it("keeps natural soak as post-stable observation rather than restoring an M4 gate", () => {
    expect(PENDING_GATES).not.toContain("Natural 24-hour");
    expect(CURRENT_STATUS).toContain("validation continues after stable release");
    const documents = currentDocuments();
    const path = CURRENT_DOCS.at(-1);
    documents[path] = documents[path].replace(
      "<!-- acceptance-gates:end -->",
      "| Natural 24-hour | Pending | elapsed time |\n<!-- acceptance-gates:end -->",
    );
    expect(validateCurrentDocs(documents).join("\n")).toMatch(
      /unknown acceptance gate Natural 24-hour/,
    );
  });

  it("checks current summaries while leaving historical failures and old scope alone", () => {
    const documents = currentDocuments();
    documents[CURRENT_DOCS[0]] +=
      "\nHistorical receipt: M0 not started; M3 acceptance pending, exit 1.\n";
    expect(validateCurrentDocs(documents)).toEqual([]);
  });

  it("rejects a reopened M3, false acceptance claim, missing or duplicated status block", () => {
    for (const replacement of ["M3 remains open", "M4 is complete", "all acceptance passed"]) {
      const documents = currentDocuments();
      documents[CURRENT_DOCS[0]] = documents[CURRENT_DOCS[0]].replace(
        "M4 is in progress",
        replacement,
      );
      expect(validateCurrentDocs(documents).join("\n")).toMatch(/scope contract/);
    }
    const documents = currentDocuments();
    documents[CURRENT_DOCS[0]] += documents[CURRENT_DOCS[0]];
    expect(validateCurrentDocs(documents).join("\n")).toMatch(/expected one current-status block/);
    delete documents[CURRENT_DOCS[0]];
    expect(validateCurrentDocs(documents).join("\n")).toMatch(/missing current status document/);
  });

  it("fails closed on missing, duplicated or passed gates and missing evidence", () => {
    for (const replacement of [
      "",
      "| Visual UI | Passed | CI is green |",
      "| Visual UI | Pending | |",
      "| Visual UI | Pending | evidence |\n| Visual UI | Pending | duplicate |",
    ]) {
      const documents = currentDocuments();
      const path = CURRENT_DOCS.at(-1);
      documents[path] = documents[path].replace(
        "| Visual UI | Pending | Actual evidence required |",
        replacement,
      );
      expect(validateCurrentDocs(documents).join("\n")).toMatch(
        /Visual UI needs exactly one Pending row/,
      );
    }
  });

  it("does not accept fenced markers or reversed markers", () => {
    const documents = currentDocuments();
    documents[CURRENT_DOCS[0]] = `\`\`\`md\n${documents[CURRENT_DOCS[0]]}\n\`\`\``;
    expect(validateCurrentDocs(documents).join("\n")).toMatch(/expected one current-status block/);
    documents[CURRENT_DOCS[0]] = "<!-- current-status:end -->\n<!-- current-status:start -->";
    expect(validateCurrentDocs(documents).join("\n")).toMatch(/reversed current-status/);
  });

  it("validates this checkout and the CLI without Docker, a model or network", () => {
    expect(checkDocs(root)).toEqual([]);
    expect(
      execFileSync(process.execPath, [join(root, "scripts/docs-consistency.mjs"), root], {
        encoding: "utf8",
      }),
    ).toMatch(/no acceptance inferred/);
  });

  it("returns a nonzero CLI exit for an invalid checkout", () => {
    const { dir, put } = fixture();
    put("docs/adr/9999-new.md", adr("Passed"));
    expect(() =>
      execFileSync(process.execPath, [join(root, "scripts/docs-consistency.mjs"), dir], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
