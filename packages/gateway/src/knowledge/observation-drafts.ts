// Knowledge drafts from learned-memory notes (ADR-0011 amendment 4, A29). The Gateway composes
// the Markdown itself, without a model: one dated line per note with a numbered citation and a
// Sources list. The result is a pending Knowledge proposal; publication is the existing Admin
// review, never automatic. Only trusted, current notes of one workspace can be cited, so page
// text never reaches the tenant's Knowledge through this path (decision 5).

import { DeskmatesError, type KnowledgeProposal, type WorkspaceId } from "@deskmates/contracts";
import type { StoredEntry } from "../memory/entries.js";
import type { MemoryEntryStore } from "../memory/entries.js";
import type { KnowledgeStore } from "./knowledge.js";

/** The most notes one draft cites (A29). */
export const DRAFT_MAX_NOTES = 50;

export interface ObservationDraftRequest {
  tenantId: string;
  workspaceId: WorkspaceId;
  workspaceName: string;
  entryIds: unknown;
  title?: unknown;
  targetDocumentId?: unknown;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** The notes a draft may cite, oldest effective time first; anything else is refused. */
function citable(entries: MemoryEntryStore, workspaceId: WorkspaceId, ids: unknown): StoredEntry[] {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > DRAFT_MAX_NOTES ||
    !ids.every((id) => typeof id === "string")
  )
    throw new DeskmatesError("validation", `Select 1 to ${DRAFT_MAX_NOTES} notes`, {
      field: "entryIds",
    });
  if (new Set(ids).size !== ids.length)
    throw new DeskmatesError("validation", "A note is selected twice", { field: "entryIds" });
  const notes = (ids as string[]).map((id) => {
    const entry = entries.mustGetIn(workspaceId, id);
    if (
      entry.kind !== "note" ||
      (entry.scope !== "workspace" && entry.scope !== "bot") ||
      entry.tombstoned ||
      entry.invalidAt !== undefined ||
      entry.episodeId
    )
      throw new DeskmatesError("validation", "Only current workspace or bot notes can be cited", {
        entryId: id,
      });
    if (entry.trust !== "trusted")
      throw new DeskmatesError(
        "validation",
        "An untrusted note must be confirmed by a human before a draft can cite it",
        { entryId: id },
      );
    return entry;
  });
  return notes.sort(
    (a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.id.localeCompare(b.id),
  );
}

/** The cited lines and the Sources list, deterministic for the same notes. */
export function draftSections(notes: readonly StoredEntry[]): { lines: string; sources: string } {
  const lines = notes
    .map((note, i) => `- ${day(note.effectiveAt)}: ${note.body.trim()} [${i + 1}]`)
    .join("\n");
  const sources = notes
    .map((note, i) => {
      const learned = note.learnedBy ? `learned by ${note.learnedBy}` : `source ${note.sourceKind}`;
      const run = note.sourceRunId ? ` in run ${note.sourceRunId}` : "";
      return `${i + 1}. Note ${note.id} version ${note.version}, ${learned}${run}, effective ${note.effectiveAt}.`;
    })
    .join("\n");
  return { lines, sources };
}

export function draftFromObservations(
  entries: MemoryEntryStore,
  knowledge: KnowledgeStore,
  request: ObservationDraftRequest,
  now: Date = new Date(),
): KnowledgeProposal {
  const notes = citable(entries, request.workspaceId, request.entryIds);
  const { lines, sources } = draftSections(notes);
  const citations = notes.map((note) => ({
    workspaceId: request.workspaceId,
    entryId: note.id,
    entryVersion: note.version,
  }));
  if (request.targetDocumentId !== undefined && request.targetDocumentId !== null) {
    if (typeof request.targetDocumentId !== "string")
      throw new DeskmatesError("validation", "Expected a document id", {
        field: "targetDocumentId",
      });
    const document = knowledge.read(request.tenantId, request.targetDocumentId);
    const body = `${document.body.trimEnd()}\n\n## Observations (${day(now.toISOString())})\n\n${lines}\n\n### Sources\n\n${sources}\n`;
    return knowledge.proposeDraft(request.tenantId, {
      title: document.title,
      body,
      target: { documentId: document.id, version: document.version },
      citations,
    });
  }
  const title = typeof request.title === "string" ? request.title : "";
  const body = `Observations from workspace ${request.workspaceName}, drafted ${day(now.toISOString())}.\n\n${lines}\n\n## Sources\n\n${sources}\n`;
  return knowledge.proposeDraft(request.tenantId, { title, body, citations });
}
