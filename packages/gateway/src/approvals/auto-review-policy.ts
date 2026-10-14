// What automatic review may never decide (ADR-0002 amendment 4, B3). Deterministic and checked
// before any model is asked: an ineligible request goes to humans exactly as it does with the
// setting off. The owner kept permanent deletion and permission expansion with a human; egress,
// continuations and (until #78) browser actions are outside the reviewer's scope altogether.

import type { Approval } from "@deskmates/contracts";

export type ReviewIneligibility =
  | "egress"
  | "continuation"
  | "browser"
  | "unclassified"
  | "credential"
  | "deletion"
  | "permission"
  | "no_human_instruction"
  | "breaker";

/** Shell forms that delete for good. Matched on the whole command line, each segment. */
const DELETION: readonly RegExp[] = [
  /(^|[\s;&|(`$])(rm|rmdir|shred|unlink|srm|wipe)(\s|$)/,
  /(^|[\s;&|(`$])find\s.*\s-delete(\s|$)/,
  /(^|[\s;&|(`$])git\s+clean(\s|$)/,
  /(^|[\s;&|(`$])git\s+reset\s+.*--hard/,
  /(^|[\s;&|(`$])git\s+branch\s+.*(-D|--delete)(\s|$)/,
  /(^|[\s;&|(`$])git\s+push\s.*(--force|--force-with-lease|\s-f(\s|$)|--delete|\s:\S)/,
  /(^|[\s;&|(`$])git\s+push\s+-f(\s|$)/,
  /\b(delete\s+from|drop\s+(table|database|schema|index|view)|truncate(\s+table)?\s+\w)/i,
];

/** Shell forms that widen who may do what. */
const PERMISSION: readonly RegExp[] = [
  /(^|[\s;&|(`$])(sudo|su|doas|chmod|chown|chgrp|setfacl|usermod|useradd|groupadd|passwd|visudo|setcap)(\s|$)/,
  /authorized_keys|sudoers/,
];

/** The text a shell-like request runs, or undefined for any other tool. */
function commandOf(approval: Approval): string | undefined {
  const input = approval.action.input;
  if (typeof input.command === "string") return input.command;
  if (typeof input.input === "string" && approval.action.toolName.includes("tty"))
    return input.input;
  return undefined;
}

/** A browser action: the Playwright MCP tools, or the Playwright CLI driven from a shell. */
function isBrowser(approval: Approval, command: string | undefined): boolean {
  if (/(^|__)browser_/.test(approval.action.toolName)) return true;
  return command !== undefined && /(^|[\s;&|])(npx\s+)?(playwright-cli|playwright)\s/.test(command);
}

/** Why a request is not eligible for review, or undefined when it may be reviewed. */
export function reviewIneligibility(
  approval: Approval,
  facts: { scrubbedSecrets: boolean },
): ReviewIneligibility | undefined {
  if (approval.kind === "egress") return "egress";
  if (approval.kind === "continuation") return "continuation";
  const command = commandOf(approval);
  if (isBrowser(approval, command)) return "browser";
  if (approval.action.unclassified) return "unclassified";
  if (facts.scrubbedSecrets) return "credential";
  const texts = [command, approval.action.argumentSummary, approval.action.filePath].filter(
    (text): text is string => typeof text === "string",
  );
  if (approval.action.sqlStatementKind === "delete" || approval.action.sqlStatementKind === "ddl")
    return "deletion";
  if (texts.some((text) => DELETION.some((pattern) => pattern.test(text)))) return "deletion";
  if (texts.some((text) => PERMISSION.some((pattern) => pattern.test(text)))) return "permission";
  return undefined;
}
