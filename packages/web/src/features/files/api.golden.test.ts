// T0 wire golden for the files API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import {
  type GoldenCases,
  WS,
  exerciseCase,
  recordingFetch,
  wireGolden,
} from "../../platform/http-golden.js";
import { createHttpTransport } from "../../platform/http-transport.js";
import { type FilesApi, createFilesApi } from "./api.js";

const CASES: GoldenCases<FilesApi> = {
  cancelWorkspaceUpload: (a) => a.cancelWorkspaceUpload(WS, "upl/1"),
  completeWorkspaceUpload: (a) => a.completeWorkspaceUpload(WS, "upl/1"),
  createWorkspaceUpload: (a) =>
    a.createWorkspaceUpload(WS, { name: "a b.pdf", sizeBytes: 5, idempotencyKey: "k1" }),
  downloadWorkspaceFile: (a) => a.downloadWorkspaceFile(WS, "out/report a.pdf"),
  getWorkspaceUpload: (a) => a.getWorkspaceUpload(WS, "upl/1"),
  listWorkspaceFiles: (a) =>
    a.listWorkspaceFiles(WS, { offset: 10, limit: 5, type: "all", source: "bot", q: "rep" }),
  readWorkspaceFileRange: (a, signal) =>
    a.readWorkspaceFileRange(WS, "out/a.pdf", { previewId: "pv/1", start: 0, end: 3, signal }),
  sendWorkspaceUploadPart: (a, signal) =>
    a.sendWorkspaceUploadPart(WS, "upl/1", { offset: 4, part: new Blob(["abc"]), signal }),
  workspaceFileDownloadUrl: (a) => a.workspaceFileDownloadUrl(WS, "out/report a.pdf"),
};

describe("files API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createFilesApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });

  it("turns a thrown fetch during a download into a network ApiError", async () => {
    const blob = await exerciseCase(createFilesApi, CASES.downloadWorkspaceFile, "network");
    expect(blob.outcome).toMatchObject({ rejected: { code: "network", status: 0 } });
    expect(blob.unauthorized).toBe(0);
  });

  it("refuses a range answer without a parseable content-range", async () => {
    const bad = await exerciseCase(createFilesApi, CASES.readWorkspaceFileRange, "badRange");
    expect(bad.outcome).toEqual({
      rejected: {
        error: "ApiError",
        code: "unknown",
        message: "Invalid file range response",
        status: 502,
        details: {},
      },
    });
  });

  it("builds a download URL without a tenant when the transport has none", () => {
    const api = createFilesApi(createHttpTransport({ fetch: recordingFetch("ok").fetch }));
    expect(api.workspaceFileDownloadUrl(WS, "a b")).toBe("/api/workspaces/ws%2F1/files?path=a+b");
  });
});
