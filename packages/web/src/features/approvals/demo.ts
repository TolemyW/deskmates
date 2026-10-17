// Demo routes and seed of approvals: the pending and decided list, decisions (an egress allow
// adds the host to the workspace allowlist, ADR-0020; Always stores a rule) that resume the
// parked run, and per-bot approval rules. The seeded pending asks are part of the core history.

import {
  APPROVAL_ATTACHMENT_MIME,
  APPROVAL_EXPIRY_DEFAULT_MINUTES,
  APPROVAL_MODE_DEFAULT,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalMode,
  type ApprovalRule,
  isApprovalMode,
} from "@deskmates/contracts";
import type { GatewayEvent } from "../../api/types.js";
import type { DemoFeature, DemoRequest, DemoSeedContext } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, id, ignoreCancelled, minutesAgo } from "../../demo/state.js";
import { resumeAfterApproval } from "../../demo/team.js";

export const demo: DemoFeature = { route, seed: { after: "team", run: seed } };

/** The demo's approval mode per workspace (ADR-0002 amendment 6); automatic by default. */
const approvalMode = new Map<string, ApprovalMode>();
/** The demo's request expiry per workspace (ADR-0002 amendment 3, A7). */
const approvalExpiry = new Map<string, number>();

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/approval-rules$/))) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    if (method === "POST") {
      const rule: ApprovalRule = {
        id: id("rul"),
        botId: bot.id,
        matcher: b.matcher as ApprovalRule["matcher"],
        decision: b.decision as ApprovalRule["decision"],
        createdBy: "human:operator",
        createdAt: new Date().toISOString(),
      };
      s.rules.push(rule);
      return created({ rule });
    }
    // #113 slice B: a numbered page with the total.
    const rules = s.rules.filter((rule) => rule.botId === bot.id);
    const offset = Number(q.get("offset") ?? 0) || 0;
    const limit = Number(q.get("limit") ?? 25) || 25;
    return ok({ rules: rules.slice(offset, offset + limit), offset, limit, total: rules.length });
  }
  // ADR-0043 decision 6: a rule is edited in place.
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/approval-rules\/([^/]+)$/)) && method === "PATCH") {
    const rule = s.rules.find((item) => item.id === decodeURIComponent(x?.[1] ?? ""));
    if (!rule) return notFound("approval rule");
    if (b.decision === "allow_always" || b.decision === "deny") rule.decision = b.decision;
    if (b.matcher && typeof b.matcher === "object")
      rule.matcher = b.matcher as ApprovalRule["matcher"];
    return ok({ rule });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/approval-rules\/([^/]+)$/)) && method === "DELETE") {
    const i = s.rules.findIndex((rule) => rule.id === decodeURIComponent(x?.[1] ?? ""));
    if (i >= 0) s.rules.splice(i, 1);
    return ok({ deleted: true });
  }
  if (path === "/api/approvals" && method === "GET") {
    const named = q.has("ids") ? new Set((q.get("ids") ?? "").split(",")) : undefined;
    // A chat names the approvals of its loaded messages; both states unless asked (#113, 26).
    const status = q.get("status") ?? (named ? "all" : "pending");
    const threadId = q.get("threadId");
    const approvals = [...s.approvals.values()].filter(
      (a) =>
        (!named || named.has(a.id)) &&
        (status === "all" ||
          (status === "pending" ? a.decision === undefined : a.decision !== undefined)) &&
        (!threadId || a.threadId === threadId),
    );
    // The demo's pending queue fits one page; the inbox still gets its total (#113 surface 23).
    return ok(
      status === "pending" && !threadId ? { approvals, total: approvals.length } : { approvals },
    );
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/auto-approval$/))) {
    const workspaceId = decodeURIComponent(x[1] ?? "");
    if (method === "PUT" && isApprovalMode(b.mode)) approvalMode.set(workspaceId, b.mode);
    if (method === "PUT" && typeof b.enabled === "boolean")
      approvalMode.set(workspaceId, b.enabled ? "automatic" : "manual");
    if (method === "PUT" && typeof b.expiryMinutes === "number")
      approvalExpiry.set(workspaceId, b.expiryMinutes);
    const mode = approvalMode.get(workspaceId) ?? APPROVAL_MODE_DEFAULT;
    return ok({
      autoApproval: {
        workspaceId,
        mode,
        enabled: mode === "automatic",
        expiryMinutes: approvalExpiry.get(workspaceId) ?? APPROVAL_EXPIRY_DEFAULT_MINUTES,
      },
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/approvals\/([^/]+)\/decide$/))) {
    const approval = s.approvals.get(decodeURIComponent(x[1] ?? "") as ApprovalId);
    if (!approval) return notFound("approval");
    if (approval.decision)
      return { status: 409, json: { code: "conflict", message: "already decided", details: {} } };
    const decision = b.decision as ApprovalDecision;
    if (approval.kind === "egress" && decision === "allow_once") {
      return {
        status: 400,
        json: {
          code: "validation",
          message: "an egress decision is allow_always (allow this site) or deny",
          details: {},
        },
      };
    }
    approval.decision = decision;
    approval.decidedBy = "human:operator";
    approval.decidedAt = new Date().toISOString();
    if (typeof b.reason === "string") approval.reason = b.reason;
    let rule: ApprovalRule | undefined;
    if (approval.kind === "egress" && decision === "allow_always") {
      // ADR-0020: the asked host joins the workspace allowlist; no tool rule is stored.
      const bot = s.bot(approval.botId);
      const ws = bot ? s.workspaces.find((w) => w.id === bot.workspaceId) : undefined;
      const host = new URL(approval.action.targetOrigin ?? "https://invalid").hostname;
      if (ws && host && !ws.egressAllowlist.includes("*") && !ws.egressAllowlist.includes(host)) {
        ws.egressAllowlist = [...ws.egressAllowlist, host];
        ws.egressUpdatedAt = new Date().toISOString();
        s.emit({ type: "workspace", workspaceId: ws.id, workspace: ws });
      }
    } else if (decision === "allow_always") {
      rule = {
        id: id("rul"),
        botId: approval.botId,
        matcher: {
          toolName: approval.action.toolName,
          ...(approval.action.targetOrigin ? { targetOrigin: approval.action.targetOrigin } : {}),
          ...(approval.action.argumentPattern
            ? { argumentPattern: approval.action.argumentPattern }
            : {}),
        },
        decision: "allow_always",
        createdFromApprovalId: approval.id,
        createdBy: "human:operator",
        createdAt: new Date().toISOString(),
      };
      s.rules.push(rule);
    }
    const thread = approval.threadId ? s.thread(approval.threadId) : undefined;
    if (thread) {
      const label =
        decision === "deny"
          ? "Denied"
          : approval.kind === "egress"
            ? "Site allowed"
            : decision === "allow_always"
              ? "Always allowed"
              : "Allowed once";
      s.post(
        thread,
        "system",
        "",
        `${label} by operator${approval.reason ? `: ${approval.reason}` : ""}`,
        {
          attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: approval.id }],
        },
      );
    }
    s.emit({ type: "approval", threadId: approval.threadId, approval } as GatewayEvent);
    const run = s.runs.get(approval.runId);
    if (run) void resumeAfterApproval(s, run, approval).catch(ignoreCancelled);
    return ok({ approval, ...(rule ? { rule } : {}) });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/approvals\/([^/]+)$/))) {
    const approval = s.approvals.get(decodeURIComponent(x[1] ?? "") as ApprovalId);
    return approval ? ok({ approval }) : notFound("approval");
  }
  return undefined;
}

/** The researcher may always open the ops console. */
function seed(s: DemoState, { now, researcher }: DemoSeedContext): void {
  s.rules.push({
    id: id("rul"),
    botId: researcher.id,
    matcher: {
      toolName: "mcp__browser__browser_navigate",
      targetOrigin: "https://ops.example.test",
    },
    decision: "allow_always",
    createdBy: "human:operator",
    createdAt: minutesAgo(60 * 24 * 3, now),
  });
}
