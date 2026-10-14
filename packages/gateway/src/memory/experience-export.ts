// The MEMORY.md export of a bot (ADR-0011 "what this supersedes"): its trusted, live experience
// notes, one bullet each with authority, source and date. Untrusted entries and candidates are
// not experience and are not exported.

import type { MemoryEntry } from "@deskmates/contracts";
import { isLive } from "./validity.js";

export function renderExperienceExport(
  botName: string,
  entries: readonly MemoryEntry[],
  now: Date = new Date(),
): string {
  const notes = entries.filter(
    (entry) =>
      entry.scope === "bot" &&
      entry.kind === "note" &&
      entry.trust === "trusted" &&
      isLive(entry, now),
  );
  const lines = [`# ${botName}: experience`, ""];
  if (notes.length === 0) lines.push("No trusted experience yet.");
  for (const note of notes)
    lines.push(
      `- [${note.authority} · ${note.sourceKind} · ${note.observedAt.slice(0, 10)}] ${note.body.replace(/\n/g, "\n  ")}`,
    );
  return `${lines.join("\n")}\n`;
}

/** Canonical MEMORY.md combines the preserved operator file with current trusted experience. */
export function renderCanonicalMemory(
  botName: string,
  legacyHumanNotes: string,
  entries: readonly MemoryEntry[],
  now: Date = new Date(),
): string {
  const notes = legacyHumanNotes;
  return [
    "# Memory",
    "",
    "## Human notes (preserved from the previous MEMORY.md)",
    "",
    notes === "" ? "No human notes yet." : notes,
    "",
    "## Learned experience",
    "",
    renderExperienceExport(botName, entries, now).trim(),
    "",
  ].join("\n");
}
