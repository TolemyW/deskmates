// Demo routes of the workspace Vault (ADR-0045): an empty catalog per workspace in automatic
// approval mode. Entries can be added, edited and deleted; the demo keeps no value at all, only
// whether a username was given, as the Gateway returns no value either.

import type {
  VaultEntry,
  VaultEntryType,
  VaultRequestDefinition,
  VaultView,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

interface VaultStore {
  entries: VaultEntry[];
  next: number;
}

const NOW = "2026-10-17T12:00:00.000Z";

function store(s: DemoState): VaultStore {
  return s.store<VaultStore>("vault", () => ({ entries: [], next: 1 }));
}

function view(s: DemoState, workspaceId: string): VaultView {
  return {
    workspaceId,
    available: true,
    approvalMode: "automatic",
    entries: store(s).entries.filter((e) => e.workspaceId === workspaceId),
  };
}

function usable(entry: VaultEntry): VaultEntry {
  const reason = !entry.enabled
    ? "disabled"
    : entry.type === "http_header_token" && entry.requests.length === 0
      ? "no_request_definition"
      : undefined;
  const { unusableReason: _previous, ...rest } = entry;
  return { ...rest, usable: reason === undefined, ...(reason ? { unusableReason: reason } : {}) };
}

function refused(message: string, status = 400): Result {
  return {
    status,
    json: { code: status === 409 ? "invalid_transition" : "validation", message, details: {} },
  };
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const list = req.match(/^\/api\/workspaces\/([^/]+)\/vault$/);
  const one = req.match(/^\/api\/workspaces\/([^/]+)\/vault\/([^/]+)(\/value|\/requests)?$/);
  const match = list ?? one;
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1] ?? "");
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  const vault = store(s);
  if (list) {
    if (req.method === "GET") return ok({ vault: view(s, workspaceId) });
    if (req.method !== "POST") return undefined;
    const b = req.body;
    const type = b.type as VaultEntryType;
    if (typeof b.name !== "string" || b.name.trim() === "") return refused("name is required");
    if (typeof b.targetOrigin !== "string" || !b.targetOrigin.startsWith("https://"))
      return refused("targetOrigin must be an exact https:// origin");
    const entry = usable({
      id: `vlt_demo_${vault.next++}`,
      workspaceId,
      name: b.name.trim(),
      ...(typeof b.purpose === "string" && b.purpose ? { purpose: b.purpose } : {}),
      type,
      targetOrigin: b.targetOrigin.replace(/\/$/, ""),
      enabled: true,
      revision: 1,
      hasUsername: typeof b.username === "string" && b.username !== "",
      usable: true,
      requests: [],
      createdAt: NOW,
      createdBy: "user:demo",
      updatedAt: NOW,
      updatedBy: "user:demo",
    });
    vault.entries.push(entry);
    return created({ entry });
  }
  const entryId = decodeURIComponent(match[2] ?? "");
  const index = vault.entries.findIndex((e) => e.workspaceId === workspaceId && e.id === entryId);
  const entry = vault.entries[index];
  if (!entry) return notFound("entry");
  const expected =
    req.method === "DELETE" ? Number(req.query.get("expectedRevision")) : req.body.expectedRevision;
  if (expected !== entry.revision) return refused("the entry changed since this edit started", 409);
  if (req.method === "DELETE" && !match[3]) {
    vault.entries.splice(index, 1);
    return ok({ deleted: entryId });
  }
  const bumped = { ...entry, revision: entry.revision + 1, updatedAt: NOW };
  let next: VaultEntry;
  if (req.method === "PATCH" && !match[3])
    next = usable({
      ...bumped,
      ...(typeof req.body.enabled === "boolean" ? { enabled: req.body.enabled } : {}),
      ...(typeof req.body.name === "string" ? { name: req.body.name } : {}),
    });
  else if (req.method === "PUT" && match[3] === "/value")
    next = usable({
      ...bumped,
      hasUsername: typeof req.body.username === "string" && req.body.username !== "",
    });
  else if (req.method === "PUT" && match[3] === "/requests" && Array.isArray(req.body.requests))
    next = usable({
      ...bumped,
      requests: (req.body.requests as VaultRequestDefinition[]).map((r, i) => ({
        ...r,
        id: r.id ?? `vrq_demo_${entry.revision}_${i}`,
      })),
    });
  else return undefined;
  vault.entries[index] = next;
  return ok({ entry: next });
}

export const demo: DemoFeature = { route };
