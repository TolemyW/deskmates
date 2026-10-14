// Public-mirror guard: no tracked file may contain a blocked private identifier (a host name,
// a LAN address, a person's name, a private e-mail address, a former product name). The
// identifiers themselves are not stored here; `public-scan-blocklist.json` holds sha256 hashes
// of lower-cased tokens, so the list can live in the public tree without naming anything.
//
// CLI:  node scripts/public-scan.mjs            scan every tracked file, exit 1 on a finding
//       node scripts/public-scan.mjs --hash a b  print the hashes to add for tokens a and b
//
// Tokens are: runs of letters and digits (case-insensitive), dotted IPv4 literals plus their
// first three octets, and e-mail addresses. `docs/runbooks/public-mirror.md` explains the flow.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BLOCKLIST_PATH = join(here, "public-scan-blocklist.json");

// Media and archives carry no identifiers a grep would catch; the lockfile is third-party metadata.
const SKIP =
  /(\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|tar|gz|sqlite|db|wasm)|package-lock\.json)$/i;

export function hashToken(token) {
  return createHash("sha256").update(token.toLowerCase()).digest("hex");
}

export function loadBlocklist(path = BLOCKLIST_PATH) {
  const { hashes } = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(hashes) || !hashes.every((h) => /^[0-9a-f]{64}$/.test(h)))
    throw new Error(`${path}: hashes must be an array of sha256 hex strings`);
  return new Set(hashes);
}

export function tokensOf(line) {
  const out = new Set();
  for (const m of line.matchAll(/[A-Za-z0-9]+/g)) out.add(m[0].toLowerCase());
  for (const m of line.matchAll(/\d{1,3}(?:\.\d{1,3}){3}/g)) {
    out.add(m[0]);
    out.add(m[0].slice(0, m[0].lastIndexOf(".")));
  }
  for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g))
    out.add(m[0].toLowerCase());
  return out;
}

/** Findings in one text: `{ line, token }` for every blocked token, first occurrence per line. */
export function scanText(text, blocked) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries())
    for (const token of tokensOf(line))
      if (blocked.has(hashToken(token))) findings.push({ line: index + 1, token });
  return findings;
}

function trackedFiles(root) {
  return execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/** Findings across every tracked text file under `root`: `{ file, line, token }`. */
export function scanRepo(root, blocked = loadBlocklist()) {
  const findings = [];
  for (const file of trackedFiles(root)) {
    if (SKIP.test(file)) continue;
    let buffer;
    try {
      buffer = readFileSync(join(root, file));
    } catch {
      continue; // a submodule directory or a dangling symlink
    }
    if (buffer.subarray(0, 8000).includes(0)) continue;
    for (const finding of scanText(buffer.toString("utf8"), blocked))
      findings.push({ file, ...finding });
  }
  return findings;
}

export function formatFindings(findings, limit = 40) {
  const lines = findings.slice(0, limit).map((f) => `${f.file}:${f.line}: ${f.token}`);
  if (findings.length > limit) lines.push(`... and ${findings.length - limit} more`);
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args[0] === "--hash") {
    for (const token of args.slice(1)) console.log(`${hashToken(token)}  ${token}`);
  } else {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const findings = scanRepo(root);
    if (findings.length) {
      console.error(`public-scan: ${findings.length} blocked identifier(s) in tracked files`);
      console.error(formatFindings(findings));
      process.exit(1);
    }
    console.log("public-scan: clean");
  }
}
