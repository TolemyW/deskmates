// Attachment cards under a chat message (ADR-0014 amendment A5 decision 42). A workspace-path
// attachment, from a person's upload or a bot's `thread_post`, is one card: type icon, name, size
// when known, Preview (the shared preview drawer), Download and Show in Files, which opens Files at
// the file's directory with the file selected (amendment A7). Any other attachment (an artifact
// URL or a reference this screen cannot open) stays a plain line, as before.

import type { Attachment, WorkspaceId } from "@deskmates/contracts";
import { FolderOpen } from "lucide-react";
import type { ApiClient } from "../../api/client.js";
import { useT } from "../../i18n/i18n-provider.js";
import { filesHref } from "../../router.js";
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
  const t = useT();
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
              <a
                className="attachment-card-files"
                href={filesHref({ workspaceId, path: attachment.ref })}
                aria-label={t("files.showInFilesLabel", { name: attachment.name })}
                title={t("files.showInFiles")}
              >
                <FolderOpen size={16} aria-hidden="true" />
                <span>{t("files.showInFiles")}</span>
              </a>
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
