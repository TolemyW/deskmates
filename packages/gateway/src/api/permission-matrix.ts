// The route half of the permission model (docs/design/m4-permission-model-2026-10-07.md,
// section 7), generated from the code that enforces it into docs/generated/permission-matrix.md
// so the tables cannot drift: `/api` routes come from `ROUTE_POLICY`, every other route on either
// listener needs an entry below. `permission-matrix.test.ts` regenerates that file and fails when
// it, the route table or these entries disagree.

import { ROUTE_POLICY, type RoutePolicy } from "./route-policy.js";

/** Operator-listener routes outside `/api` (and the one `/api` route outside its scope). */
export const OPERATOR_ROUTE_RULES: Readonly<Record<string, string>> = {
  "GET /auth/session":
    "Anyone. Reports the session for the selected tenant, or issues a pre-login token.",
  "POST /auth/login": "Anyone with the pre-login token (login CSRF) from the same origin.",
  "POST /auth/logout": "Signed-in session, same origin, session CSRF. Ends this session.",
  "POST /auth/logout-all":
    "Signed-in session, same origin, session CSRF. Ends every session of this person.",
  "POST /auth/password":
    "Signed-in local session, same origin, session CSRF, current password. Rotates this session, ends the others.",
  "POST /auth/oidc/:provider/start":
    "`login`: pre-login token. `link`: session authenticated in the last 10 minutes. `tenant_grant`: session of an active member of a tenant that links the provider. Same origin and CSRF in every case.",
  "GET /auth/oidc/callback":
    "The single-use state from the start request, presented by the browser that started it (and, for link and step-up, the same live session).",
  "POST /auth/oidc/:provider/backchannel-logout":
    "The provider's IdP, server to server: a logout token signed by a key in the provider's JWKS, for this client, recent, single-use. Ends the sessions and step-up grants that IdP user or IdP session established.",
  "GET /auth/invitations/:token":
    "Holder of an open invitation token. Shows tenant, role and bound identity.",
  "POST /auth/invitations/accept":
    "Holder of an open invitation, as the bound identity: a new login name (pre-login token), the invited local account's own session (session CSRF), or an SSO login asserting the invited email.",
  "GET /api/integrations/oauth/callback":
    "The single-use OAuth state; a grant started from a session completes only in that session while it is an Admin of the workspace's tenant.",
  "GET /api/channel-webhooks/:workspaceId/:pluginId":
    "The configured channel provider. The release-bundled plugin authenticates the untouched request envelope before accepting it.",
  "POST /api/channel-webhooks/:workspaceId/:pluginId":
    "The configured channel provider. The release-bundled plugin authenticates the untouched request envelope before accepting it.",
  "POST /hooks/:botId/:token": "The bot's webhook token. Starts a background run of that bot only.",
};

/** Sandbox-listener routes: everything a run, and so a bot, can reach. */
export const SANDBOX_ROUTE_RULES: Readonly<Record<string, string>> = {
  "GET /healthz": "Anyone. Liveness only.",
  "POST /v1/*": "A live run token. The model proxy; the token never leaves the sandbox listener.",
  "POST /internal/runs/:runId/events": "That run's token. Appends to its own ledger.",
  "POST /internal/runs/:runId/ended": "That run's token. Ends its own run.",
  "POST /internal/runs/:runId/messages":
    "That run's token. `thread_post` posts in the run's own thread; `message_bot` reaches another bot of the same workspace.",
  "POST /internal/runs/:runId/approvals":
    "That run's token. Asks for an approval in its own thread (PreToolUse hook).",
  "GET /internal/runs/:runId/approvals/:approvalId": "That run's token, for its own approvals.",
  "POST /internal/runs/:runId/approvals/:approvalId/decide":
    "That run's token, when its bot is a member of the approval's thread, is not the requesting bot and is not upstream in the requesting run's wake chain; allow_once or deny only (approval_decide; ADR-0002 amendments 2 and 3, A10).",
  "POST /internal/runs/:runId/browser-lock": "That run's token. Its workspace's browser lock.",
  "POST /internal/runs/:runId/browser-origin": "That run's token. Its workspace's origin queue.",
  "GET /internal/runs/:runId/browser-retention": "That run's token. Its workspace's tabs.",
  "POST /internal/runs/:runId/browser-retention/closed": "That run's token. Its workspace's tabs.",
  "GET /internal/runs/:runId/egress": "That run's token. Its workspace's egress allowlist.",
  "GET /internal/runs/:runId/knowledge/search": "That run's token. Its tenant's Knowledge.",
  "GET /internal/runs/:runId/knowledge/:id": "That run's token. A document of its tenant.",
  "POST /internal/runs/:runId/knowledge/proposals":
    "That run's token. Proposes to its tenant's Knowledge; an Admin reviews.",
  "GET /internal/runs/:runId/memory/search": "That run's token. Its workspace's learned memory.",
  "POST /internal/runs/:runId/reply-preview":
    "That run's token, for its current attempt while live. Relays a reply preview to the run's own thread stream; writes no ledger row or message (ADR-0037).",
  "POST /internal/runs/:runId/tasks/:taskId/deliver":
    "That run's token, for a task of its workspace linked to the run or its thread (task_deliver; ADR-0021 amendment 2). Files are verified through the workspace before publication (ADR-0014 A4). Never accepts.",
  "POST /internal/runs/:runId/app-shares":
    "That run's token. Publishes a port of its workspace's container for the workspace's signed-in Members (app_publish; ADR-0035). Never opens the app.",
  "POST /internal/runs/:runId/operations/look":
    "That run's token. Forwards one look/OCR request on bytes the sidecar read to the installation's vision service (image_describe; ADR-0040). Never fetches a URL.",
  "POST /internal/runs/:runId/operations/asr":
    "That run's token. Forwards one transcription request on bytes the sidecar read to the installation's speech service (audio_transcribe; ADR-0040).",
  "POST /internal/runs/:runId/tasks/:taskId/checkpoints":
    "That run's token, for a task of its workspace linked to the run or its thread (task_checkpoint; ADR-0021 A3h). Changes no task state; publishes nothing.",
  "POST /internal/runs/:runId/connectors/:connector/describe":
    "That run's token. A connector of its workspace its bot names.",
  "POST /internal/runs/:runId/connectors/:connector/validate":
    "That run's token. A connector of its workspace its bot names.",
  "POST /internal/runs/:runId/connectors/:connector/submit":
    "That run's token, with a stored validation of the same content (ADR-0012 item 5).",
  "GET /internal/runs/:runId/connectors/:connector/status/:receiptId":
    "That run's token. Receipts of its workspace's connector.",
  "GET /internal/runs/:runId/connectors/:connector/receipt/:receiptId":
    "That run's token. Receipts of its workspace's connector.",
  "GET /internal/runs/:runId/connectors/:connector/validations/:validationId":
    "That run's token. Validations of its workspace's connector.",
  "GET /internal/runs/:runId/integrations/apps": "That run's token. Its workspace's connections.",
  "GET /internal/runs/:runId/integrations/connections":
    "That run's token. Connections its bot is allowed.",
  "POST /internal/runs/:runId/integrations/search": "That run's token. Allowed connections only.",
  "POST /internal/runs/:runId/integrations/guide": "That run's token. Allowed connections only.",
  "POST /internal/runs/:runId/integrations/execute":
    "That run's token. Allowed connections only; L2 actions need an approval.",
  "GET /internal/runs/:runId/integrations/actions/:actionId/tier":
    "That run's token. Risk tier lookup.",
};

type TenantPolicy = Extract<RoutePolicy, { access: "tenant" }>;

const ACCESS_ORDER = [
  "platform",
  "root",
  "authenticated",
  "owner",
  "admin",
  "member",
  "guest",
] as const;

const ACCESS_TITLE: Record<(typeof ACCESS_ORDER)[number], string> = {
  platform: "Platform maintenance (a platform maintainer, or the operator credential)",
  root: "The root alone (the protected account `admin`, or the operator credential; ADR-0022 amendment 6 W2)",
  authenticated: "Any signed-in principal (installation-wide facts, no tenant data)",
  owner:
    "Owner of the workspace every identifier names (naming none: of a workspace of the request's tenant)",
  admin:
    "Admin or Owner of the workspace every identifier names (naming none: of a workspace of the request's tenant)",
  member:
    "Member, Admin or Owner of the workspace every identifier names (naming none: a Member of a workspace of the request's tenant)",
  guest:
    "Anyone who belongs to the workspace every identifier names, Guests included (naming none: anyone in the request's tenant; lists show only their workspaces)",
};

function routeOrder(a: string, b: string): number {
  const [ma = "", pa = ""] = a.split(" ");
  const [mb = "", pb = ""] = b.split(" ");
  return pa === pb ? ma.localeCompare(mb) : pa.localeCompare(pb);
}

function checkedIds(policy: TenantPolicy): string {
  const parts: string[] = [];
  for (const [where, ids] of [
    ["path", policy.params],
    ["query", policy.query],
    ["body", policy.body],
  ] as const)
    for (const [name, kind] of Object.entries(ids ?? {}))
      parts.push(`${where} \`${name}\`: ${kind}`);
  if (policy.scopedList) parts.push("list scoped to the tenant and the caller's workspaces");
  if (policy.handlerCheck) parts.push(`handler: ${policy.handlerCheck}`);
  return parts.join("; ") || "none";
}

/** The generated section of the permission model, in Markdown. */
export function permissionMatrixMarkdown(): string {
  const lines: string[] = [];
  lines.push("### Operator API (the `/api` guard), from `ROUTE_POLICY`", "");
  for (const access of ACCESS_ORDER) {
    const keys = Object.entries(ROUTE_POLICY)
      .filter(([, policy]) =>
        policy.access === "tenant" ? policy.role === access : policy.access === access,
      )
      .map(([key]) => key)
      .sort(routeOrder);
    if (keys.length === 0) continue;
    lines.push(`#### ${ACCESS_TITLE[access]} (${keys.length})`, "");
    if (access === "platform" || access === "root" || access === "authenticated") {
      lines.push("| Route |", "|---|");
      for (const key of keys) lines.push(`| \`${key}\` |`);
    } else {
      lines.push(
        "| Route | Identifiers the guard resolves to the tenant and to their workspace |",
        "|---|---|",
      );
      for (const key of keys)
        lines.push(`| \`${key}\` | ${checkedIds(ROUTE_POLICY[key] as TenantPolicy)} |`);
    }
    lines.push("");
  }
  lines.push("### Operator listener, outside the `/api` guard", "");
  lines.push("| Route | Who may call it |", "|---|---|");
  for (const key of Object.keys(OPERATOR_ROUTE_RULES).sort(routeOrder))
    lines.push(`| \`${key}\` | ${OPERATOR_ROUTE_RULES[key]} |`);
  lines.push("", "### Sandbox listener (run tokens)", "");
  lines.push("| Route | Who may call it |", "|---|---|");
  for (const key of Object.keys(SANDBOX_ROUTE_RULES).sort(routeOrder))
    lines.push(`| \`${key}\` | ${SANDBOX_ROUTE_RULES[key]} |`);
  return `${lines.join("\n").trimEnd()}\n`;
}
