// The `PreToolUse` hook's desktop rules (ADR-0048, owner rulings of 2026-10-17):
//
//  - decision 2: a desktop call is allowed without asking anyone; the network targets its code
//    names literally must pass the ADR-0020 hard denies (private addresses, IP literals, local
//    names, unreadable URLs) unless a network profile grants the exact origin, and in a locked
//    workspace a public host outside the allowlist is denied, never asked;
//  - decision 3: a shell line that runs the LCU binary is refused with where to go instead.
//
// Both read the literal input only. Computed targets and a script that starts LCU indirectly pass
// here; the managed egress proxy and the guard-rail wording are the honest limits (decision 4).

import {
  type NetworkGrant,
  egressAllows,
  isPublicHostname,
  networkGrantAllowsUrl,
} from "@deskmates/contracts";
import { splitMcpToolName } from "../risk-tier.js";
import { basename, shellArgvs, unwrapArgv } from "../shell-words.js";
import { desktopCodeEffects, desktopCodeTargets, desktopToolCode } from "./desktop-code-effects.js";

/** Schemes that reach the network; `file:`, `data:` and the like name no host to deny. */
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);

/** Where the image puts LCU (ADR-0048 decision 11; the spike's `/opt/lcu/current/bin/lcu`). */
const LCU_PREFIX = "/opt/lcu/";

/** What the `tool_call` event records for a desktop call (decision 2). */
export interface DesktopCallFacts {
  desktopEffects: string[];
  desktopTargets?: string[];
}

/** The labels and literal targets of a desktop call, for the ledger. */
export function desktopCallFacts(
  toolName: string,
  input: Record<string, unknown>,
): DesktopCallFacts {
  const { tool } = splitMcpToolName(toolName);
  if (tool !== "js") return { desktopEffects: [] };
  const code = desktopToolCode(tool, input);
  const targets = desktopCodeTargets(code);
  return {
    desktopEffects: desktopCodeEffects(code),
    ...(targets.length > 0 ? { desktopTargets: targets } : {}),
  };
}

/** The literal network targets of a desktop call; empty for `js_reset`. */
export function desktopCallTargets(toolName: string, input: Record<string, unknown>): string[] {
  const { tool } = splitMcpToolName(toolName);
  return desktopCodeTargets(desktopToolCode(tool, input));
}

/**
 * A desktop call refused for a network target (decision 2), as amendment 1, A4 records it: the
 * host (never the URL, which may carry a token), the kind of refusal and the reason the bot gets.
 */
export interface DesktopNetworkDenial {
  host?: string;
  kind: "hard_deny" | "not_in_allowlist" | "unreadable";
  reason: string;
}

/**
 * Why to deny a desktop call for one of its literal targets, or undefined when every one passes.
 * A desktop call never asks (decision 2): an unlisted public host in a locked workspace is a
 * denial whose reason says an Owner or Admin adds the host to the allowlist.
 */
export function desktopNetworkDenial(
  targets: readonly string[],
  allowlist: readonly string[],
  grants: readonly NetworkGrant[],
): DesktopNetworkDenial | undefined {
  for (const target of targets) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return { kind: "unreadable", reason: "egress_blocked: desktop code names an unreadable URL" };
    }
    if (!NETWORK_SCHEMES.has(url.protocol)) continue;
    if (networkGrantAllowsUrl(grants, target)) continue;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "" || !isPublicHostname(host))
      return {
        ...(host === "" ? {} : { host }),
        kind: host === "" ? "unreadable" : "hard_deny",
        reason: `egress_blocked: desktop code names ${host || "no host"}, a private address, IP literal or local name`,
      };
    if (!egressAllows(host, allowlist))
      return {
        host,
        kind: "not_in_allowlist",
        reason: `egress_blocked: desktop code names ${host}, which is not in the workspace allowlist; desktop calls do not ask, so an Owner or Admin adds the host to the allowlist first`,
      };
  }
  return undefined;
}

/** The reason alone, for callers that only refuse. */
export function desktopNetworkRefusal(
  targets: readonly string[],
  allowlist: readonly string[],
  grants: readonly NetworkGrant[],
): string | undefined {
  return desktopNetworkDenial(targets, allowlist, grants)?.reason;
}

/** Whether one argv runs the LCU binary: basename `lcu` or a path under `/opt/lcu/`. */
function runsLcu(argv: readonly string[]): boolean {
  const cmd = unwrapArgv(argv);
  const program = cmd[0] ?? "";
  if (basename(program) === "lcu" || program.startsWith(LCU_PREFIX)) return true;
  // `sh /opt/lcu/...`, `node /opt/lcu/...`: an interpreter given a file under LCU's prefix.
  return cmd.slice(1).some((word) => word.startsWith(LCU_PREFIX));
}

/** Whether a shell line runs the LCU binary anywhere in it. */
export function invokesLcu(command: string): boolean {
  if (command.trim() === "") return false;
  return shellArgvs(command).some(runsLcu);
}

/**
 * Decision 3: the reason to refuse a shell line that runs LCU, or undefined. With the tools on,
 * the bot is told to use them; with them off, that they are off. Not a boundary: a script that
 * starts LCU itself is not read here.
 */
export function desktopShellRefusal(command: string, desktopEnabled: boolean): string | undefined {
  if (!invokesLcu(command)) return undefined;
  return desktopEnabled
    ? "desktop_shell_refused: run desktop actions with the mcp__desktop__js tool, not LCU from the shell, so they share the workspace lock, takeover and ledger"
    : "desktop_shell_refused: native desktop tools are not enabled for this bot; an Owner or Admin enables them on the workspace page";
}
