// ADR-0014 decision 5: absolute workspace paths in a message body become download links.
//
// A path token starts with `/work/` or `/home/`, continues over `[A-Za-z0-9._\-/]`, and ends at
// the first other character, so full-width punctuation (`，` `。` `）`), spaces and newlines end
// it; trailing `.` is sentence punctuation, not part of the path. A token preceded by a path
// character (`work/a.md`, `./work/a.md`, `/tmp/work/a.md`) is not a workspace path. Tokens the
// Gateway would refuse anyway by shape (a directory, a `..` segment) stay plain text; which bot
// homes exist is the Gateway's decision.
//
// Clicking fetches the file with the operator credential and saves the blob through a temporary
// `<a download>`: the page never navigates to the file and never renders its content.

import type { WorkspaceId } from "@deskmates/contracts";
import type { ApiClient } from "../../api/client.js";

export type BodySegment = { kind: "text"; text: string } | { kind: "path"; path: string };

const TOKEN = /(?<![A-Za-z0-9._\-/])\/(?:work|home)\/[A-Za-z0-9._\-/]*/g;

function linkable(path: string): boolean {
  const segments = path.split("/").slice(1);
  const minimum = segments[0] === "home" ? 3 : 2;
  return (
    segments.length >= minimum &&
    !path.endsWith("/") &&
    !segments.some((segment) => segment === "" || segment === "..")
  );
}

/** Split a message body into plain text and workspace path segments; joined, they are the body. */
export function splitWorkspacePaths(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const pushText = (value: string): void => {
    if (value === "") return;
    const last = segments.at(-1);
    if (last?.kind === "text") last.text += value;
    else segments.push({ kind: "text", text: value });
  };
  let cursor = 0;
  for (const match of body.matchAll(TOKEN)) {
    const start = match.index;
    // Keep the whole unsupported name as text instead of inventing a truncated file card.
    if (/^[\p{L}\p{N}\p{M}]/u.test(body.slice(start + match[0].length))) continue;
    const quote = body[start - 1];
    if (quote === '"' || quote === "'" || quote === "`") {
      const close = body.indexOf(quote, start);
      // An explicitly quoted path is one value. Never link its valid ASCII prefix when the
      // full quoted value contains spaces the Gateway will refuse.
      if (close > start && /\s/.test(body.slice(start, close))) continue;
    }
    const path = match[0].replace(/\.+$/, "");
    if (!linkable(path)) continue;
    pushText(body.slice(cursor, start));
    segments.push({ kind: "path", path });
    cursor = start + path.length;
  }
  pushText(body.slice(cursor));
  return segments;
}

/**
 * Start a same-origin attachment navigation. The browser streams the response to its download
 * sink; no page-owned Blob holds the whole file (ADR-0014 A3 decision 17).
 */
export async function downloadWorkspaceFile(
  api: ApiClient,
  workspaceId: WorkspaceId,
  path: string,
): Promise<number> {
  const url = api.workspaceFileDownloadUrl(workspaceId, path);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.slice(path.lastIndexOf("/") + 1);
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
  // Native downloads do not expose a byte count to the page.
  return 0;
}
