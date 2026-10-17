// Attachment cards under a chat message (ADR-0014 amendment A5 decision 42). A workspace-path
// attachment, from a person's upload or a bot's `thread_post`, is one card: type icon, name, size
// when known, Preview (the shared preview drawer) and Download. Any other attachment (an artifact
// URL or a reference this screen cannot open) stays a plain line, as before.

import type { Attachment, WorkspaceId } from "@deskmates/contracts";
import type { ApiClient } from "../../api/client.js";
import { WorkspaceFilePreview } from "../files/workspace-file-preview.js";

/** A path inside the workspace filesystem, the only ref a card can preview or download. */
export function isWorkspacePathAttachment(attachment: Attachment): boolean {
  const segments = attachment.ref.split("/");
  return (
    segments[0] === "" &&
    (segments[1] === "work" || segments[1] === "home") &&
    segments.length >= 3 &&
    !segments.slice(1).some((segment) => segment === "" || segment === "..")
  );
}

export function AttachmentCards({
  attachments,
  api,
  workspaceId,
}: {
  attachments: readonly Attachment[];
  api: ApiClient;
  /** Unknown until the thread detail loads; cards wait for it and plain lines stand in. */
  workspaceId: WorkspaceId | undefined;
}) {
  if (attachments.length === 0) return null;
  const cards =
    workspaceId === undefined ? [] : attachments.filter((a) => isWorkspacePathAttachment(a));
  const others = attachments.filter((a) => !cards.includes(a));
  return (
    <>
      {cards.length > 0 && workspaceId !== undefined ? (
        <ul className="attachment-cards">
          {cards.map((attachment) => (
            <li key={`${attachment.ref}:${attachment.uploadId ?? attachment.name}`}>
              <WorkspaceFilePreview
                api={api}
                workspaceId={workspaceId}
                path={attachment.ref}
                card={{ name: attachment.name, sizeBytes: attachment.sizeBytes }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {others.length > 0 ? (
        <ul className="attachments small">
          {others.map((a) => (
            <li key={`${a.name}:${a.ref}`}>
              {a.name} <span className="muted">({a.mimeType})</span> {a.ref}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
