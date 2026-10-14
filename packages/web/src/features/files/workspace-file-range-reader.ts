import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_RANGES,
  WORKSPACE_FILE_RANGE_BYTES,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { ApiClient } from "../../api/client.js";

export type WorkspaceFileRangeApi = Pick<ApiClient, "readWorkspaceFileRange">;

export interface WorkspaceFileRange {
  bytes: Uint8Array;
  fileSize: number;
  start: number;
  end: number;
}

let previewCounter = 0;

function previewId(): string {
  previewCounter += 1;
  return `preview_${Date.now().toString(36)}_${previewCounter.toString(36).padStart(8, "0")}`;
}

/**
 * One browser preview identity with the same limits as the Gateway.
 *
 * The client-side accounting fails before making an avoidable request. The Gateway remains the
 * authority and independently binds this id to one workspace path, expiry, 64 ranges and 64 MiB.
 */
export class WorkspaceFileRangeReader {
  readonly id = previewId();
  readonly controller = new AbortController();
  #ranges = 0;
  #bytes = 0;

  constructor(
    private readonly api: WorkspaceFileRangeApi,
    private readonly workspaceId: WorkspaceId,
    private readonly path: string,
    private readonly parentSignal?: AbortSignal,
  ) {
    parentSignal?.addEventListener("abort", () => this.abort(), { once: true });
  }

  get ranges(): number {
    return this.#ranges;
  }

  get bytes(): number {
    return this.#bytes;
  }

  abort(): void {
    this.controller.abort();
  }

  async read(start: number, endExclusive: number): Promise<WorkspaceFileRange> {
    const length = endExclusive - start;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endExclusive) ||
      start < 0 ||
      length < 1 ||
      length > WORKSPACE_FILE_RANGE_BYTES
    )
      throw new Error("Workspace file preview requested an invalid range");
    if (
      this.#ranges + 1 > WORKSPACE_FILE_PREVIEW_MAX_RANGES ||
      this.#bytes + length > WORKSPACE_FILE_PREVIEW_MAX_BYTES
    )
      throw new Error("Workspace file preview exhausted its bounded range budget");
    this.#ranges += 1;
    this.#bytes += length;
    const result = await this.api.readWorkspaceFileRange(this.workspaceId, this.path, {
      previewId: this.id,
      start,
      end: endExclusive - 1,
      signal: this.controller.signal,
    });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    if (result.start !== start || bytes.byteLength > length)
      throw new Error("Workspace file range response did not match its request");
    return {
      bytes,
      fileSize: result.fileSize,
      start: result.start,
      end: result.end,
    };
  }
}
