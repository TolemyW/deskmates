// The chat composer's attach control (ADR-0014 amendment A5 decision 34). It uploads the chosen
// files into the workspace and then hands each final workspace path to the composer, which adds
// it to the person's draft. Nothing is sent: the bot sees the path only when the person sends the
// message. Uploading alone starts no run and posts nothing.

import type { WorkspaceId } from "@deskmates/contracts";
import { Button } from "@deskmates/ui";
import { Paperclip } from "lucide-react";
import { type ChangeEvent, useRef } from "react";
import { useT } from "../../i18n/i18n-provider.js";
import { UploadJobList, useWorkspaceUploads } from "./files-upload.js";
import type { UploadApi } from "./upload-driver.js";

/** The draft with `path` added on its own line, so decision 5's path token ends cleanly. */
export function draftWithPath(draft: string, path: string): string {
  if (draft === "") return path;
  return /\s$/.test(draft) ? `${draft}${path}` : `${draft}\n${path}`;
}

export function UploadAttachButton({
  api,
  workspaceId,
  onUploaded,
  disabled,
}: {
  api: UploadApi;
  workspaceId: WorkspaceId | undefined;
  /** Receives each completed upload's workspace path. */
  onUploaded: (path: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const uploads = useWorkspaceUploads(api, workspaceId, (upload) => {
    if (upload.path) onUploaded(upload.path);
  });
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    uploads.start(chosen);
  };
  // Finished jobs leave the composer once their path is in the draft; the rest stay visible.
  const visible = {
    ...uploads,
    jobs: uploads.jobs.filter((job) => job.state !== "completed"),
  };
  return (
    <span className="composer-attach">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="composer-attach-input"
        onChange={choose}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("files.upload.attach")}
        title={t("files.upload.attachHint")}
        disabled={disabled === true || workspaceId === undefined}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={18} aria-hidden="true" />
      </Button>
      <UploadJobList uploads={visible} />
    </span>
  );
}
