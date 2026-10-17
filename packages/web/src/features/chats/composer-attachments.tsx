// Chat composer attachments (ADR-0014 amendment A5 decision 41). Files come from the paperclip,
// a drop anywhere on the chat pane or a paste into the composer; each one uploads at once through
// the Files upload driver and waits as a chip until Send. Send carries the completed uploads' ids
// (decision 42); an upload alone posts nothing. Leaving the chat cancels uploads still in flight.

import { type MessageUploadAttachment, type WorkspaceId, fileKindOf } from "@deskmates/contracts";
import { Button } from "@deskmates/ui";
import {
  File as FileIcon,
  FileImage,
  FileText,
  Globe,
  Paperclip,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DOMAttributes,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useT } from "../../i18n/i18n-provider.js";
import { formatFileSize } from "../files/file-size.js";
import {
  type UploadJob,
  type WorkspaceUploads,
  useWorkspaceUploads,
} from "../files/files-upload.js";
import type { UploadApi } from "../files/upload-driver.js";
import { VisionBadge } from "./vision-notice.js";

/** The icon of a file's type, from its extension only. */
export function FileTypeIcon({ name, size = 16 }: { name: string; size?: number }) {
  const kind = fileKindOf(name);
  if (kind === "images") return <FileImage size={size} aria-hidden="true" />;
  if (kind === "documents") return <FileText size={size} aria-hidden="true" />;
  if (kind === "web") return <Globe size={size} aria-hidden="true" />;
  return <FileIcon size={size} aria-hidden="true" />;
}

const CLIPBOARD_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
/** Names browsers give a pasted screenshot or a copied image that carries no file name. */
const GENERIC_CLIPBOARD_NAME = /^image\.(png|jpe?g|gif|webp)$/i;

/**
 * The files of a paste. A nameless clipboard image (a screenshot) is named
 * `pasted-<UTC date and time>.<type>`, so two pastes in a row stay distinguishable.
 */
export function pastedFiles(data: Pick<DataTransfer, "files"> | null, now = new Date()): File[] {
  const files = [...(data?.files ?? [])];
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return files.map((file, index) => {
    if (file.name !== "" && !GENERIC_CLIPBOARD_NAME.test(file.name)) return file;
    const extension = CLIPBOARD_EXTENSION[file.type] ?? "bin";
    const suffix = files.length > 1 ? `-${index + 1}` : "";
    return new File([file], `pasted-${stamp}${suffix}.${extension}`, { type: file.type });
  });
}

/** True when a drag carries files, not text or a link dragged out of the page. */
function carriesFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

export interface ComposerAttachments {
  uploads: WorkspaceUploads;
  /** Completed uploads in the order they were added, ready for Send. */
  ready: MessageUploadAttachment[];
  /** A chip is still sending or failed: Send waits until it is done, retried or removed. */
  blocked: boolean;
  add(files: readonly File[]): void;
  /** Forget the chips that a sent message carried. */
  sent(ids: readonly MessageUploadAttachment[]): void;
}

/** The pending attachments of one chat; a new thread starts empty and cancels what was sending. */
export function useComposerAttachments(
  api: UploadApi,
  workspaceId: WorkspaceId | undefined,
  threadId: string,
): ComposerAttachments {
  const uploads = useWorkspaceUploads(api, workspaceId);
  const clear = useRef(uploads.clear);
  clear.current = uploads.clear;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new thread clears the chips
  useEffect(() => () => clear.current(), [threadId]);
  const ready = uploads.jobs
    .filter((job) => job.state === "completed" && job.uploadId !== undefined)
    .map((job) => ({ uploadId: job.uploadId as string }));
  return {
    uploads,
    ready,
    blocked: uploads.jobs.some((job) => job.state === "uploading" || job.state === "failed"),
    add(files) {
      if (files.length > 0) uploads.start(files);
    },
    sent(ids) {
      const done = new Set(ids.map((entry) => entry.uploadId));
      for (const job of uploads.jobs)
        if (job.uploadId !== undefined && done.has(job.uploadId)) uploads.dismiss(job.key);
    },
  };
}

/** Paste handler for the composer form: files become uploads, text stays text. */
export function onComposerPaste(
  attachments: ComposerAttachments,
  enabled: boolean,
): (event: ClipboardEvent) => void {
  return (event) => {
    if (!enabled) return;
    const files = pastedFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attachments.add(files);
  };
}

function Chip({ job, uploads }: { job: UploadJob; uploads: WorkspaceUploads }) {
  const t = useT();
  const percent = job.size === 0 ? 100 : Math.floor((job.sent / job.size) * 100);
  return (
    <li className={`composer-chip ${job.state}`} data-state={job.state}>
      <FileTypeIcon name={job.name} />
      <span className="composer-chip-text">
        <span className="composer-chip-name" title={job.name}>
          {job.name}
        </span>
        <span className="composer-chip-meta muted">
          {job.state === "uploading"
            ? t("chatPane.attach.uploading", { percent, size: formatFileSize(job.size) })
            : job.state === "failed"
              ? t("chatPane.attach.failed", { error: job.error ?? "" })
              : job.state === "cancelled"
                ? t("chatPane.attach.cancelled")
                : formatFileSize(job.size)}
        </span>
        {job.state === "uploading" ? (
          <progress
            max={100}
            value={percent}
            aria-label={t("chatPane.attach.progress", { name: job.name })}
          />
        ) : null}
      </span>
      {job.state === "failed" ? (
        <button
          type="button"
          className="composer-chip-action"
          aria-label={t("chatPane.attach.retry", { name: job.name })}
          title={t("chatPane.attach.retry", { name: job.name })}
          onClick={() => uploads.retry(job.key)}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        className="composer-chip-action"
        aria-label={
          job.state === "uploading"
            ? t("chatPane.attach.cancel", { name: job.name })
            : t("chatPane.attach.remove", { name: job.name })
        }
        title={
          job.state === "uploading"
            ? t("chatPane.attach.cancel", { name: job.name })
            : t("chatPane.attach.remove", { name: job.name })
        }
        onClick={() => uploads.dismiss(job.key)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

/** The chips above the composer's text; nothing when no file was added. */
export function ComposerAttachmentChips({ attachments }: { attachments: ComposerAttachments }) {
  const t = useT();
  const { uploads } = attachments;
  if (uploads.jobs.length === 0) return null;
  return (
    <ul className="composer-chips" aria-label={t("chatPane.attach.listLabel")}>
      {uploads.jobs.map((job) => (
        <Chip key={job.key} job={job} uploads={uploads} />
      ))}
    </ul>
  );
}

/** The paperclip: choose files to attach. */
export function ComposerAttachButton({
  attachments,
  disabled,
  blindNames = [],
}: {
  attachments: ComposerAttachments;
  disabled?: boolean;
  /** Members whose model cannot see an attached image: the clip says so beside itself. */
  blindNames?: readonly string[];
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    attachments.add(chosen);
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
        aria-label={t("chatPane.attach.button")}
        title={t("chatPane.attach.hint")}
        disabled={disabled === true}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={18} aria-hidden="true" />
      </Button>
      <VisionBadge names={blindNames} />
    </span>
  );
}

/**
 * Drop target over the whole chat pane: spread `handlers` on the pane and render `overlay` in
 * it. While files are dragged over the pane, the overlay says they will be attached; dropping
 * adds them as chips. Dragged text or links are left alone.
 */
export function useChatDropTarget(
  attachments: ComposerAttachments,
  enabled: boolean,
): { handlers: DOMAttributes<HTMLElement>; active: boolean; overlay: ReactNode } {
  const t = useT();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const handlers: DOMAttributes<HTMLElement> = {
    onDragEnter(event) {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver(event) {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(event) {
      if (!enabled || !carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop(event) {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      attachments.add([...event.dataTransfer.files]);
    },
  };
  const overlay =
    over && enabled ? (
      <div className="chat-drop-overlay" aria-hidden="true">
        <Upload size={28} />
        <span>{t("chatPane.attach.drop")}</span>
      </div>
    ) : null;
  return { handlers, active: over && enabled, overlay };
}
