// @vitest-environment jsdom
import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_RANGES,
  WORKSPACE_FILE_RANGE_BYTES,
  type WorkspaceId,
} from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { WorkspaceFileRangeReader } from "./workspace-file-range-reader.js";

const workspaceId = "ws_range_reader" as WorkspaceId;

function byteBlob(): Blob {
  const bytes = new Uint8Array([0x25]);
  return {
    size: 1,
    type: "application/octet-stream",
    arrayBuffer: async () => bytes.buffer,
  } as Blob;
}

function api() {
  return {
    readWorkspaceFileRange: vi.fn(
      async (_workspaceId: WorkspaceId, _path: string, input: { start: number }) => ({
        blob: byteBlob(),
        fileSize: 2 * 1024 ** 3,
        start: input.start,
        end: input.start,
      }),
    ),
  } as unknown as Pick<ApiClient, "readWorkspaceFileRange">;
}

describe("WorkspaceFileRangeReader", () => {
  it("stops before a 65th range or a byte beyond the 64 MiB session budget", async () => {
    const client = api();
    const reader = new WorkspaceFileRangeReader(client, workspaceId, "/work/huge.pdf");

    for (let index = 0; index < WORKSPACE_FILE_PREVIEW_MAX_RANGES; index += 1)
      await reader.read(
        index * WORKSPACE_FILE_RANGE_BYTES,
        (index + 1) * WORKSPACE_FILE_RANGE_BYTES,
      );

    expect(reader.ranges).toBe(WORKSPACE_FILE_PREVIEW_MAX_RANGES);
    expect(reader.bytes).toBe(WORKSPACE_FILE_PREVIEW_MAX_BYTES);
    await expect(
      reader.read(WORKSPACE_FILE_PREVIEW_MAX_BYTES, WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1),
    ).rejects.toThrow(/bounded range budget/);
    expect(client.readWorkspaceFileRange).toHaveBeenCalledTimes(WORKSPACE_FILE_PREVIEW_MAX_RANGES);
  });

  it("rejects an oversized single range without sending it", async () => {
    const client = api();
    const reader = new WorkspaceFileRangeReader(client, workspaceId, "/work/huge.pdf");

    await expect(reader.read(0, WORKSPACE_FILE_RANGE_BYTES + 1)).rejects.toThrow(/invalid range/);
    expect(client.readWorkspaceFileRange).not.toHaveBeenCalled();
  });

  it("propagates cancellation to in-flight API calls", async () => {
    const client = api();
    const parent = new AbortController();
    const reader = new WorkspaceFileRangeReader(
      client,
      workspaceId,
      "/work/huge.pdf",
      parent.signal,
    );

    parent.abort();
    await reader.read(0, 1);

    expect(client.readWorkspaceFileRange).toHaveBeenCalledWith(
      workspaceId,
      "/work/huge.pdf",
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
    );
  });
});
