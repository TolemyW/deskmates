// Read-only, dependency-free documentation traceability check. This does not run ADR proofs.
// CLI: node scripts/docs-consistency.mjs [repository-root]
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_DOCS = [
  "README.md",
  "AGENTS.md",
  "docs/design/design-cogbot-thin-core-v0.3-2026-09-20.md",
  "docs/design/m3-owner-scope-closeout-and-m4-backlog-2026-10-03.md",
  "docs/design/m4-status-2026-10-04.md",
];

export const CURRENT_STATUS =
  "M3 is closed under the owner-revised scope. M4 is in progress. " +
  "Task management (ADR-0021) is merged; runtime, real-model, statistical, " +
  "visual acceptance remain pending. " +
  "Natural 24-hour soak is not an M4 gate; validation continues after stable release.";

export const PENDING_GATES = [
  "Visual UI",
  "Docker/runtime and domain",
  "Real-model and memory",
  "Real SaaS provider",
  "Statistical strategy",
  "WhatsApp manual",
  "ADR-0022 tenant gates",
];

// Ignore fenced examples; preserve line positions for actionable errors.
function proseLines(source) {
  let fence;
  return source.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return "";
    }
    return fence ? "" : line;
  });
}

function cells(line) {
  // Markdown table pipes must be escaped even inside inline code.
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** Extract only the leading item references, never numbers in explanatory prose. */
export function verificationIds(label) {
  const ids = [];
  let rest = label;
  while (rest) {
    const match = rest.match(/^(A?\d+[a-z]?)(?:\s*[-–]\s*(A?\d+[a-z]?))?/);
    if (!match) break;
    // IDs are positive safe integers (optionally A-prefixed or letter-suffixed).
    // Unsafe Number endpoints can round together and make n++ stop advancing.
    const number = Number(match[1].match(/\d+/)[0]);
    if (!Number.isSafeInteger(number) || number <= 0) return [];
    if (!match[2] && /^\s*[-–]/.test(rest.slice(match[0].length))) return [];
    if (!match[2]) ids.push(match[1]);
    else {
      const start = match[1].match(/^(A?)(\d+)$/);
      const end = match[2].match(/^(A?)(\d+)$/);
      if (!start || !end || start[1] !== end[1]) return [];
      const first = Number(start[2]);
      const last = Number(end[2]);
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        first <= 0 ||
        last <= 0 ||
        last < first ||
        last - first > 1000
      )
        return [];
      for (let n = first; n <= last; n++) ids.push(`${start[1]}${n}`);
    }
    rest = rest.slice(match[0].length);
    if (!/^\s*,\s*(?:A?\d)/.test(rest)) break;
    rest = rest.replace(/^\s*,\s*/, "");
  }
  return ids;
}

/** An ADR's own header only; amendment statuses do not override it. */
export function validateAdr(source, name = "ADR") {
  const errors = [];
  const lines = proseLines(
    source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " ")),
  );
  const headerEnd = lines.findIndex((line) => /^##\s/.test(line));
  const header = lines.slice(0, headerEnd < 0 ? lines.length : headerEnd);
  const statuses = header.filter((line) => /^Status:/.test(line));
  if (statuses.length !== 1) errors.push(`${name}: expected exactly one top-level Status line`);
  const status = statuses[0]?.slice("Status:".length).trim() ?? "";
  const superseded = status.match(/^Superseded by ADR-(\d{4})(?:$|\s+on\s+\d{4}-\d{2}-\d{2}$)/);
  const qualified = /^(?:Accepted|Proposed)(?:$|\s+(?:\(|for\b|by\b))/i.test(status);
  // This one historical header describes activation, not decision acceptance. Keep it explicit.
  const legacy =
    name.endsWith("0006-operator-api-auth-and-workspace-networks.md") &&
    status.startsWith("Implementation in progress (B4 activated 2026-09-23;") &&
    status.endsWith("acceptance pending");
  if (!qualified && !superseded && !legacy)
    errors.push(`${name}: invalid ADR status ${JSON.stringify(status)}`);
  if (superseded) return { errors, supersededBy: superseded[1], decisions: [] };

  let section = "";
  const headings = [];
  let table;
  let verificationTables = 0;
  const decisions = new Set();
  const covered = new Set();
  const referenced = new Set();
  for (const [index, line] of lines.entries()) {
    const heading = line.match(/^(#{2,6})\s+(.+)/);
    if (heading) {
      const level = heading[1].length;
      while (headings.length && headings.at(-1).level >= level) headings.pop();
      headings.push({ level, title: heading[2] });
      // Ordinary subsections inherit their semantic parent. Explicit Context,
      // Alternatives, etc. stop inheritance, so their lists are not decisions.
      section = "";
      for (const { title } of [...headings].reverse()) {
        if (/^(?:Decisions?$|Amendment\b|Verification\b)/.test(title)) {
          section = title;
          break;
        }
        if (
          /^(?:Context|Problem|Alternatives?|Consequences|Definitions|Open items|Open questions)\b/.test(
            title,
          )
        )
          break;
      }
      table = undefined;
      continue;
    }
    if (/^(?:Decisions?$|Amendment\b)/.test(section)) {
      // Indented numeric lists are substeps, except the explicit existing 4a-style IDs.
      const item = line.match(/^(A?\d+[a-z]?)\.\s/) ?? line.match(/^ {1,3}(\d+[a-z])\.\s/);
      if (item) {
        if (decisions.has(item[1]))
          errors.push(`${name}:${index + 1}: duplicate decision ${item[1]}`);
        decisions.add(item[1]);
      }
    }
    if (!/^Verification(?:$|\s*\()/.test(section) || !line.trim().startsWith("|")) {
      table = undefined;
      continue;
    }
    const row = cells(line);
    if (/^(?:Item|Decision)$/.test(row[0])) {
      table = { header: row, separatorSeen: false };
      verificationTables++;
      if (
        row.length !== 4 ||
        !/^(?:Means|Concrete meaning)$/.test(row[1]) ||
        !/^(?:Test|Executable proof|Test \/ evidence|Required verification)$/.test(row[2]) ||
        row[3] !== "Metric"
      )
        errors.push(
          `${name}:${index + 1}: Verification needs Item/Decision, meaning, test, Metric columns`,
        );
      continue;
    }
    if (!table) continue;
    if (!table.separatorSeen) {
      if (row.length !== 4 || !row.every((cell) => /^:?-{3,}:?$/.test(cell))) {
        errors.push(`${name}:${index + 1}: Verification table needs a Markdown separator row`);
        table = undefined;
      } else table.separatorSeen = true;
      continue;
    }
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const ids = verificationIds(row[0]);
    for (const id of ids) referenced.add(id);
    if (row.length !== 4 || row.some((cell) => !cell)) {
      errors.push(`${name}:${index + 1}: Verification row must have four nonempty cells`);
      continue;
    }
    for (const id of ids) covered.add(id);
  }
  if (!decisions.size) errors.push(`${name}: no numbered decisions found`);
  if (!verificationTables) errors.push(`${name}: missing Verification table`);
  for (const id of decisions)
    if (!covered.has(id)) errors.push(`${name}: decision ${id} has no complete Verification row`);
  for (const id of referenced)
    if (!decisions.has(id)) errors.push(`${name}: Verification references unknown decision ${id}`);
  return { errors, decisions: [...decisions] };
}

function markedBlock(source, marker, name, errors) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const prose = proseLines(source).join("\n");
  if (prose.split(start).length !== 2 || prose.split(end).length !== 2) {
    errors.push(`${name}: expected one ${marker} block`);
    return "";
  }
  const from = prose.indexOf(start) + start.length;
  const to = prose.indexOf(end);
  if (to < from) {
    errors.push(`${name}: reversed ${marker} markers`);
    return "";
  }
  return prose.slice(from, to).trim();
}

/** Bounded, explicit status contract, not a heuristic scan of historical receipts. */
export function validateCurrentDocs(documents) {
  const errors = [];
  for (const path of CURRENT_DOCS) {
    const source = documents[path];
    if (typeof source !== "string") {
      errors.push(`${path}: missing current status document`);
      continue;
    }
    const block = markedBlock(source, "current-status", path, errors);
    if (block.replace(/\s+/g, " ") !== CURRENT_STATUS)
      errors.push(`${path}: current status differs from the explicit M3/M4 scope contract`);
    if (path !== CURRENT_DOCS.at(-1) && !source.includes("m4-status-2026-10-04.md"))
      errors.push(`${path}: missing M4 status ledger reference`);
  }
  const ledger = CURRENT_DOCS.at(-1);
  if (typeof documents[ledger] === "string") {
    const block = markedBlock(documents[ledger], "acceptance-gates", ledger, errors);
    const rows = block
      .split("\n")
      .filter((line) => line.trim().startsWith("|"))
      .map(cells);
    const gateRows = rows.filter(
      (row) => row[0] !== "Gate" && !row.every((cell) => /^:?-+:?$/.test(cell)),
    );
    for (const gate of PENDING_GATES) {
      const matches = gateRows.filter((row) => row[0] === gate);
      if (
        matches.length !== 1 ||
        matches[0][1] !== "Pending" ||
        !matches[0][2] ||
        matches[0].length !== 3
      )
        errors.push(`${ledger}: ${gate} needs exactly one Pending row with required evidence`);
    }
    for (const row of gateRows)
      if (!PENDING_GATES.includes(row[0]))
        errors.push(`${ledger}: unknown acceptance gate ${row[0]}`);
  }
  return errors;
}

export function checkDocs(root) {
  const errors = [];
  const adrs = new Map();
  let names;
  try {
    names = readdirSync(join(root, "docs/adr"))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (error) {
    return [`docs/adr: cannot read ADR directory (${error.code})`];
  }
  if (!names.length) errors.push("docs/adr: no ADR files found");
  for (const name of names) {
    const id = name.match(/^(\d{4})-[\w-]+\.md$/)?.[1];
    if (!id) {
      errors.push(`docs/adr/${name}: invalid ADR filename`);
      continue;
    }
    if (adrs.has(id)) errors.push(`docs/adr/${name}: duplicate ADR number ${id}`);
    try {
      const source = readFileSync(join(root, "docs/adr", name), "utf8");
      const result = validateAdr(source, name);
      adrs.set(id, { source, name, ...result });
      errors.push(...result.errors);
    } catch (error) {
      errors.push(`docs/adr/${name}: cannot read ADR (${error.code})`);
    }
  }
  for (const [id, adr] of adrs) {
    if (!adr.supersededBy) continue;
    const successor = adrs.get(adr.supersededBy);
    if (id === adr.supersededBy || !successor || !successor.source.includes(`ADR-${id}`))
      errors.push(`${adr.name}: superseding ADR-${adr.supersededBy} must exist and name ADR-${id}`);
  }
  const documents = {};
  for (const path of CURRENT_DOCS) {
    try {
      documents[path] = readFileSync(join(root, path), "utf8");
    } catch (error) {
      errors.push(`${path}: cannot read document (${error.code})`);
    }
  }
  return [...errors, ...validateCurrentDocs(documents)];
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const errors = checkDocs(resolve(process.argv[2] ?? join(dirname(scriptPath), "..")));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else
    console.log("Documentation consistency passed (traceability only; no acceptance inferred).");
}
