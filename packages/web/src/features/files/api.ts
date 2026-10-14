// Workspace files (ADR-0014): the referenced-files collection, whole-file downloads and bounded
// preview ranges. The caller saves or renders the bytes; nothing here navigates to them.

import type {
  CreateWorkspaceUploadRequest,
  FileCollectionQuery,
  WorkspaceFileCollectionPage,
  WorkspaceId,
  WorkspaceUpload,
} from "@deskmates/contracts";
import { ApiError } from "../../api/types.js";
import { type HttpTransport, query } from "../../platform/http-transport.js";

export interface FilesApi {
  /** Cancel a receiving upload and remove its partial file (ADR-0014 amendment A5). */
  cancelWorkspaceUpload(workspaceId: WorkspaceId, uploadId: string): Promise<WorkspaceUpload>;
  /** Commit a fully received upload; answers its final workspace path and digest. */
  completeWorkspaceUpload(workspaceId: WorkspaceId, uploadId: string): Promise<WorkspaceUpload>;
  /** Start an upload session; the same idempotency key answers the first session again. */
  createWorkspaceUpload(
    workspaceId: WorkspaceId,
    input: CreateWorkspaceUploadRequest,
  ): Promise<WorkspaceUpload>;
  /**
   * One workspace file's bytes (ADR-0014). The caller saves the Blob; nothing here renders or
   * navigates to it. Refusals arrive as ApiError with the Gateway's code.
   */
  downloadWorkspaceFile(workspaceId: WorkspaceId, path: string): Promise<Blob>;
  /** An upload's state and received bytes, for resuming after a lost answer. */
  getWorkspaceUpload(workspaceId: WorkspaceId, uploadId: string): Promise<WorkspaceUpload>;
  /**
   * One page of the workspace Files collection (ADR-0014 amendment A2): referenced paths only,
   * never a filesystem listing; reading it never starts the workspace.
   */
  listWorkspaceFiles(
    workspaceId: WorkspaceId,
    query?: Partial<FileCollectionQuery>,
  ): Promise<WorkspaceFileCollectionPage>;
  /** One authenticated range charged to a bounded preview identity (ADR-0014 A3). */
  readWorkspaceFileRange(
    workspaceId: WorkspaceId,
    path: string,
    input: { previewId: string; start: number; end: number; signal?: AbortSignal },
  ): Promise<{ blob: Blob; fileSize: number; start: number; end: number }>;
  /** Append one raw part at exactly the received length (ADR-0014 A5 decision 31). */
  sendWorkspaceUploadPart(
    workspaceId: WorkspaceId,
    uploadId: string,
    input: { offset: number; part: Blob; signal?: AbortSignal },
  ): Promise<WorkspaceUpload>;
  /** Same-origin attachment URL: the browser streams it directly to its download sink. */
  workspaceFileDownloadUrl(workspaceId: WorkspaceId, path: string): string;
}

export function createFilesApi(t: HttpTransport): FilesApi {
  const filePath = (workspaceId: WorkspaceId, path: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/files${query({ path })}`;
  const uploadPath = (workspaceId: WorkspaceId, uploadId?: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/uploads${
      uploadId === undefined ? "" : `/${encodeURIComponent(uploadId)}`
    }`;
  return {
    cancelWorkspaceUpload(workspaceId, uploadId) {
      return t.json<WorkspaceUpload>("DELETE", uploadPath(workspaceId, uploadId));
    },
    completeWorkspaceUpload(workspaceId, uploadId) {
      return t.json<WorkspaceUpload>("POST", `${uploadPath(workspaceId, uploadId)}/complete`);
    },
    createWorkspaceUpload(workspaceId, input) {
      return t.json<WorkspaceUpload>("POST", uploadPath(workspaceId), input);
    },
    getWorkspaceUpload(workspaceId, uploadId) {
      return t.json<WorkspaceUpload>("GET", uploadPath(workspaceId, uploadId));
    },
    sendWorkspaceUploadPart(workspaceId, uploadId, input) {
      return t.request<WorkspaceUpload>(
        "PUT",
        `${uploadPath(workspaceId, uploadId)}/parts${query({ offset: input.offset })}`,
        {
          body: { blob: input.part, contentType: "application/octet-stream" },
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    },
    async downloadWorkspaceFile(workspaceId, path) {
      return await (await t.download(filePath(workspaceId, path))).blob();
    },
    listWorkspaceFiles(workspaceId, filters = {}) {
      return t.json<WorkspaceFileCollectionPage>(
        "GET",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/assets${query({
          offset: filters.offset,
          limit: filters.limit,
          type: filters.type === "all" ? undefined : filters.type,
          source: filters.source === "all" ? undefined : filters.source,
          q: filters.q,
        })}`,
      );
    },
    async readWorkspaceFileRange(workspaceId, path, input) {
      const res = await t.download(filePath(workspaceId, path), {
        headers: {
          range: `bytes=${input.start}-${input.end}`,
          "x-deskmates-preview-id": input.previewId,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        res.headers.get("content-range") ?? "",
      );
      if (!contentRange) throw new ApiError("unknown", "Invalid file range response", 502);
      return {
        blob: await res.blob(),
        start: Number(contentRange[1]),
        end: Number(contentRange[2]),
        fileSize: Number(contentRange[3]),
      };
    },
    workspaceFileDownloadUrl(workspaceId, path) {
      return `${t.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/files${query({
        path,
        tenant: t.tenantId,
      })}`;
    },
  };
}
