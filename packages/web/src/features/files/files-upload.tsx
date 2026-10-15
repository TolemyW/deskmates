// Upload controls of ADR-0014 amendment A5: the Files screen's Upload button and the list of
// uploads in progress, failed, cancelled or done. Each job runs `uploadWorkspaceFile`; a failed
// job retries with its idempotency key, so it resumes the same session. Hiding the control from a
// Guest is presentation only: the Gateway refuses a Guest's upload whatever the screen offers.
// Leaving the screen cancels uploads still in flight.

import type { Workspace, WorkspaceId, WorkspaceUpload } from "@deskmates/contracts";
import { Button } from "@deskmates/ui";
import { RotateCcw, Upload, X } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/types.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useIsGuest } from "../../state/session-roles.js";
import {
  type UploadApi,
  UploadCancelled,
  newUploadKey,
  uploadWorkspaceFile,
} from "./upload-driver.js";

export interface UploadJob {
  key: string;
  name: string;
  size: number;
  sent: number;
  state: "uploading" | "completed" | "failed" | "cancelled";
  error?: string;
  path?: string;
  /** The session id, known once the Gateway created it. */
  uploadId?: string;
}

export interface WorkspaceUploads {
  jobs: readonly UploadJob[];
  start(files: Iterable<File>): void;
  cancel(key: string): void;
  retry(key: string): void;
  dismiss(key: string): void;
  /** Cancel every upload in flight and forget every job (a chat composer switching threads). */
  clear(): void;
}

/** Upload jobs of one workspace; `onCompleted` sees every finished session. */
export function useWorkspaceUploads(
  api: UploadApi,
  workspaceId: WorkspaceId | undefined,
  onCompleted?: (upload: WorkspaceUpload) => void,
): WorkspaceUploads {
  const t = useT();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const files = useRef(new Map<string, { file: File; controller?: AbortController }>());
  const completed = useRef(onCompleted);
  completed.current = onCompleted;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const owned = files.current;
    return () => {
      mounted.current = false;
      for (const entry of owned.values()) entry.controller?.abort();
    };
  }, []);

  const update = useCallback((key: string, patch: Partial<UploadJob>) => {
    if (!mounted.current) return;
    setJobs((current) => current.map((job) => (job.key === key ? { ...job, ...patch } : job)));
  }, []);

  const describe = useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError && error.code === "storage_exhausted")
        return t("files.upload.storageFull");
      if (error instanceof ApiError && error.details.reason === "workspace_not_running")
        return t("files.upload.notRunning");
      if (error instanceof ApiError && error.details.reason === "workspace_upload_quota")
        return t("files.upload.quota");
      return errorMessage(error);
    },
    [t],
  );

  const run = useCallback(
    async (key: string) => {
      const entry = files.current.get(key);
      if (!entry || workspaceId === undefined) return;
      const controller = new AbortController();
      entry.controller = controller;
      update(key, { state: "uploading" });
      try {
        const done = await uploadWorkspaceFile(api, workspaceId, entry.file, {
          idempotencyKey: key,
          signal: controller.signal,
          onProgress: (progress) =>
            update(key, { sent: progress.sentBytes, uploadId: progress.uploadId }),
        });
        update(key, {
          state: "completed",
          sent: entry.file.size,
          uploadId: done.id,
          ...(done.path ? { path: done.path } : {}),
        });
        if (mounted.current) completed.current?.(done);
      } catch (error) {
        if (error instanceof UploadCancelled) update(key, { state: "cancelled" });
        else update(key, { state: "failed", error: describe(error) });
      }
    },
    [api, workspaceId, update, describe],
  );

  return {
    jobs,
    start(chosen) {
      for (const file of chosen) {
        const key = newUploadKey();
        files.current.set(key, { file });
        setJobs((current) => [
          ...current,
          { key, name: file.name, size: file.size, sent: 0, state: "uploading" },
        ]);
        void run(key);
      }
    },
    cancel(key) {
      files.current.get(key)?.controller?.abort();
    },
    retry(key) {
      void run(key);
    },
    dismiss(key) {
      files.current.get(key)?.controller?.abort();
      files.current.delete(key);
      setJobs((current) => current.filter((job) => job.key !== key));
    },
    clear() {
      for (const entry of files.current.values()) entry.controller?.abort();
      files.current.clear();
      setJobs([]);
    },
  };
}

/** The jobs as a list: name, progress, state and the actions that state allows. */
export function UploadJobList({ uploads }: { uploads: WorkspaceUploads }) {
  const t = useT();
  if (uploads.jobs.length === 0) return null;
  return (
    <ul className="files-upload-jobs" aria-label={t("files.upload.listLabel")}>
      {uploads.jobs.map((job) => {
        const percent = job.size === 0 ? 100 : Math.floor((job.sent / job.size) * 100);
        return (
          <li key={job.key} className={`files-upload-job ${job.state}`} data-state={job.state}>
            <span className="files-upload-name" title={job.name}>
              {job.name}
            </span>
            {job.state === "uploading" ? (
              <progress
                max={100}
                value={percent}
                aria-label={t("files.upload.progress", { name: job.name })}
              />
            ) : null}
            <output className="small">
              {job.state === "uploading"
                ? t("files.upload.uploading", { percent })
                : job.state === "completed"
                  ? t("files.upload.completed", { path: job.path ?? "" })
                  : job.state === "cancelled"
                    ? t("files.upload.cancelled")
                    : t("files.upload.failed", { error: job.error ?? "" })}
            </output>
            {job.state === "uploading" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => uploads.cancel(job.key)}
              >
                {t("files.upload.cancel")}
              </Button>
            ) : null}
            {job.state === "failed" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => uploads.retry(job.key)}
              >
                <RotateCcw size={14} aria-hidden="true" /> {t("files.upload.retry")}
              </Button>
            ) : null}
            {job.state !== "uploading" ? (
              <button
                type="button"
                className="files-upload-dismiss"
                aria-label={t("files.upload.dismiss", { name: job.name })}
                onClick={() => uploads.dismiss(job.key)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The Files screen's Upload button, its honest scope note and the job list. */
export function FilesUploadControl({
  api,
  workspace,
  onUploaded,
}: {
  api: UploadApi;
  workspace: Workspace;
  onUploaded: () => void;
}) {
  const t = useT();
  const guest = useIsGuest(workspace.id);
  const input = useRef<HTMLInputElement>(null);
  const uploads = useWorkspaceUploads(api, workspace.id, onUploaded);
  if (guest) return null;
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    uploads.start(chosen);
  };
  return (
    <div className="files-upload">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="files-upload-input"
        onChange={choose}
      />
      <Button type="button" onClick={() => input.current?.click()}>
        <Upload size={16} aria-hidden="true" /> {t("files.upload.button")}
      </Button>
      <p className="muted small">{t("files.upload.hint")}</p>
      <UploadJobList uploads={uploads} />
    </div>
  );
}
