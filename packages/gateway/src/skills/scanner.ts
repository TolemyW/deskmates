// The skill scan (ADR-0015 decision 5): deterministic, the same for authored and installed skills,
// run before any run sees a version. Findings: links and commands that reach hosts outside the
// workspace allowlist, credential-shaped strings, instructions about approvals, egress, risk tiers
// or SOUL, and executable files. A finding holds the version in "needs your confirmation"; it
// never refuses it. The scan is a guard rail with recall over precision: a false finding costs a
// human one click, a missed one puts text in front of every bot the skill is enabled for.

import { type SkillFile, type SkillFinding, egressAllows } from "@deskmates/contracts";

const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s<>"'`)\]]+/gi;

/** Commands that open a connection to the host named in their arguments. */
const NETWORK_COMMAND =
  /(?:^|[\s`'"(;|&])(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet|git\s+(?:clone|fetch|push|pull|remote\s+add))\b(.*)$/i;

/** A bare hostname argument: starts an argument, has a dot, ends at a path, port or space. */
const BARE_HOST = /(?:^|[\s'"=@])((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*)(?=[/:\s'"`]|$)/gi;

const CREDENTIAL_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "API secret key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/ },
  {
    name: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    name: "password or key assignment",
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  { name: "credentials in a URL", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
];

/** Subjects a human owns (ADR-0011 rules; ADR-0015 decision 5): approvals, egress, tiers, SOUL. */
const RULE_PATTERNS: readonly RegExp[] = [
  /\bapprov(?:e|al|als|ed|ing)/i,
  /\ballow_(?:always|once)\b/i,
  /\brisk[ _-]?(?:tier|level)s?\b/i,
  /\bL[012]\b/,
  /\begress\b/i,
  /\ballow ?list/i,
  /\bSOUL\b/,
  /\bsoul\.md\b/i,
  /\bsystem prompt\b/i,
  /审批|批准|风险等级|白名单|出口规则/,
];

const EXECUTABLE_EXTENSIONS =
  /\.(?:sh|bash|zsh|fish|py|pyw|js|mjs|cjs|ts|rb|pl|php|lua|ps1|psm1|bat|cmd|exe|com|bin|so|dylib|dll|jar|appimage|run)$/i;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function hostsOn(line: string): string[] {
  const hosts: string[] = [];
  for (const match of line.matchAll(URL_PATTERN)) {
    const host = hostOf(match[0]);
    hosts.push(host ?? match[0]);
  }
  const command = NETWORK_COMMAND.exec(line);
  if (command?.[1]) {
    // URLs on the line are already counted; look at the remaining bare arguments.
    const rest = command[1].replace(URL_PATTERN, " ");
    for (const match of rest.matchAll(BARE_HOST)) if (match[1]) hosts.push(match[1]);
  }
  return hosts;
}

/** Every finding in a skill's files, in file and line order. */
export function scanSkill(
  files: readonly SkillFile[],
  allowlist: readonly string[],
): SkillFinding[] {
  const findings: SkillFinding[] = [];
  for (const file of files) {
    if (EXECUTABLE_EXTENSIONS.test(file.path))
      findings.push({ kind: "executable_file", path: file.path, detail: "script file extension" });
    else if (file.content.startsWith("#!"))
      findings.push({ kind: "executable_file", path: file.path, detail: "interpreter line (#!)" });
    const lines = file.content.split(/\r?\n/);
    lines.forEach((text, index) => {
      const line = index + 1;
      const reported = new Set<string>();
      for (const host of hostsOn(text)) {
        if (reported.has(host) || egressAllows(host, allowlist)) continue;
        reported.add(host);
        findings.push({ kind: "off_allowlist_url", path: file.path, line, detail: host });
      }
      for (const { name, pattern } of CREDENTIAL_PATTERNS) {
        if (pattern.test(text)) {
          findings.push({ kind: "credential", path: file.path, line, detail: name });
          break;
        }
      }
      for (const pattern of RULE_PATTERNS) {
        const match = pattern.exec(text);
        if (match) {
          findings.push({ kind: "rule_instruction", path: file.path, line, detail: match[0] });
          break;
        }
      }
    });
  }
  return findings;
}
