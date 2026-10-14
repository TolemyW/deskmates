// T0: the browser upload driver (ADR-0014 amendment A5 decision 31) against a fake Gateway that
// keeps only a received count, as the real one does.

import type { WorkspaceId, WorkspaceUpload } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/types.js";
import {
  UPLOAD_PART_RETRIES,
  type UploadApi,
  UploadCancelled,
  uploadWorkspaceFile,
} from "./upload-driver.js";

const WS = "ws_1" as WorkspaceId;

function fakeGateway(size: number) {
  const session: WorkspaceUpload = {
    id: "upl_1",
    workspaceId: WS,
    state: "receiving",
    name: "a.txt",
    label: "a.txt",
    sizeBytes: size,
    receivedBytes: 0,
    uploader: "user:u1",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
  const received: string[] = [];
  const failures: Array<ApiError | "lose-answer"> = [];
  const api = {
    createWorkspaceUpload: vi.fn(async () => ({ ...session })),
    getWorkspaceUpload: vi.fn(async () => ({ ...session })),
    sendWorkspaceUploadPart: vi.fn(
      async (_ws: WorkspaceId, _id: string, input: { offset: number; part: Blob }) => {
        const failure = failures.shift();
        if (failure instanceof ApiError) throw failure;
        if (input.offset !== session.receivedBytes)
          throw new ApiError("invalid_transition", "mismatch", 409, {
            reason: "upload_offset_mismatch",
            receivedBytes: session.receivedBytes,
          });
        received.push(await input.part.text());
        session.receivedBytes += input.part.size;
        if (failure === "lose-answer") throw new ApiError("network", "lost", 0);
        return { ...session };
      },
    ),
    completeWorkspaceUpload: vi.fn(async () => {
      session.state = "completed";
      session.path = "/work/uploads/2026-10-14/a.txt";
      return { ...session };
    }),
    cancelWorkspaceUpload: vi.fn(async () => ({ ...session, state: "cancelled" as const })),
  } satisfies UploadApi;
  return { api, session, received, failures };
}

const file = (text: string) => new File([text], "a.txt");

describe("uploadWorkspaceFile", () => {
  it("sends parts in order at the received length, reports progress and completes", async () => {
    const gw = fakeGateway(10);
    const progress: number[] = [];
    const done = await uploadWorkspaceFile(gw.api, WS, file("0123456789"), {
      idempotencyKey: "k",
      partBytes: 4,
      onProgress: (p) => progress.push(p.sentBytes),
    });
    expect(gw.received).toEqual(["0123", "4567", "89"]);
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(done.path).toBe("/work/uploads/2026-10-14/a.txt");
    expect(gw.api.createWorkspaceUpload).toHaveBeenCalledWith(WS, {
      name: "a.txt",
      sizeBytes: 10,
      idempotencyKey: "k",
    });
  });

  it("after a lost answer reads the received count back and does not send a part twice", async () => {
    const gw = fakeGateway(8);
    gw.failures.push("lose-answer");
    await uploadWorkspaceFile(gw.api, WS, file("abcdefgh"), { idempotencyKey: "k", partBytes: 4 });
    expect(gw.received).toEqual(["abcd", "efgh"]);
    expect(gw.api.getWorkspaceUpload).toHaveBeenCalledTimes(1);
  });

  it("resumes an existing session from its received bytes (retry with the same key)", async () => {
    const gw = fakeGateway(8);
    gw.session.receivedBytes = 4;
    await uploadWorkspaceFile(gw.api, WS, file("abcdefgh"), { idempotencyKey: "k", partBytes: 4 });
    expect(gw.received).toEqual(["efgh"]);
  });

  it("gives up after the retry budget and leaves the session for a later retry", async () => {
    const gw = fakeGateway(4);
    for (let i = 0; i <= UPLOAD_PART_RETRIES; i += 1)
      gw.failures.push(new ApiError("sandbox_unavailable", "down", 503));
    await expect(
      uploadWorkspaceFile(gw.api, WS, file("abcd"), { idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(gw.api.cancelWorkspaceUpload).not.toHaveBeenCalled();
  });

  it("does not retry a full disk; it reports it", async () => {
    const gw = fakeGateway(4);
    gw.failures.push(new ApiError("storage_exhausted", "full", 507, { receivedBytes: 0 }));
    await expect(
      uploadWorkspaceFile(gw.api, WS, file("abcd"), { idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "storage_exhausted" });
    expect(gw.api.sendWorkspaceUploadPart).toHaveBeenCalledTimes(1);
  });

  it("cancels: stops sending and deletes the session", async () => {
    const gw = fakeGateway(12);
    const controller = new AbortController();
    const upload = uploadWorkspaceFile(gw.api, WS, file("abcdefghijkl"), {
      idempotencyKey: "k",
      partBytes: 4,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.sentBytes === 4) controller.abort();
      },
    });
    await expect(upload).rejects.toBeInstanceOf(UploadCancelled);
    expect(gw.received).toEqual(["abcd"]);
    expect(gw.api.cancelWorkspaceUpload).toHaveBeenCalledWith(WS, "upl_1");
    expect(gw.api.completeWorkspaceUpload).not.toHaveBeenCalled();
  });
});
