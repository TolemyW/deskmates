// @vitest-environment jsdom
// T0: the Files screen's upload control of ADR-0014 amendment A5: progress, failure with retry and
// completion, hidden from a Guest. The chat composer's attachments are covered in
// features/chats/composer-attachments.test.tsx.

import type { WorkspaceId, WorkspaceUpload } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/types.js";
import { SessionRolesProvider } from "../../state/session-roles.js";
import { workspace } from "../../test-support/fixtures.js";
import { FilesUploadControl } from "./files-upload.js";
import type { UploadApi } from "./upload-driver.js";

afterEach(cleanup);

const WS = workspace.id as WorkspaceId;

function fakeApi(options: { failFirstPart?: ApiError } = {}) {
  let session: WorkspaceUpload | undefined;
  let fail = options.failFirstPart;
  const api = {
    createWorkspaceUpload: vi.fn(
      async (_ws: WorkspaceId, input: { name: string; sizeBytes: number }) => {
        session ??= {
          id: "upl_1",
          workspaceId: WS,
          state: "receiving",
          name: input.name,
          label: input.name,
          sizeBytes: input.sizeBytes,
          receivedBytes: 0,
          uploader: "user:u1",
          createdAt: "2026-10-14T00:00:00.000Z",
          updatedAt: "2026-10-14T00:00:00.000Z",
        };
        return { ...session };
      },
    ),
    getWorkspaceUpload: vi.fn(async () => ({ ...(session as WorkspaceUpload) })),
    sendWorkspaceUploadPart: vi.fn(async (_ws: WorkspaceId, _id: string, input: { part: Blob }) => {
      if (fail) {
        const error = fail;
        fail = undefined;
        throw error;
      }
      const current = session as WorkspaceUpload;
      current.receivedBytes += input.part.size;
      return { ...current };
    }),
    completeWorkspaceUpload: vi.fn(async () => {
      const current = session as WorkspaceUpload;
      current.state = "completed";
      current.path = `/work/uploads/2026-10-14/${current.name}`;
      return { ...current };
    }),
    cancelWorkspaceUpload: vi.fn(async () => ({ ...(session as WorkspaceUpload) })),
  } satisfies UploadApi;
  return api;
}

const choose = (testId: string, name: string, text = "hello") =>
  fireEvent.change(screen.getByTestId(testId), {
    target: { files: [new File([text], name)] },
  });

describe("FilesUploadControl", () => {
  it("shows a failure with Retry, resumes the same session, then completes and refreshes", async () => {
    const api = fakeApi({ failFirstPart: new ApiError("storage_exhausted", "full", 507) });
    const onUploaded = vi.fn();
    render(<FilesUploadControl api={api} workspace={workspace} onUploaded={onUploaded} />);
    fireEvent.click(screen.getByRole("button", { name: "About uploads" }));
    expect(await screen.findByRole("tooltip")).toHaveProperty(
      "textContent",
      expect.stringContaining("does not message a Bot"),
    );
    choose("files-upload-input", "report.csv");
    expect(await screen.findByText(/The workspace disk is full/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Uploaded to /work/uploads/2026-10-14/report.csv")).toBeTruthy();
    expect(onUploaded).toHaveBeenCalledTimes(1);
    // The retry used the same idempotency key, so the Gateway resumed one session.
    const keys = api.createWorkspaceUpload.mock.calls.map(
      (call) => (call[1] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("is hidden from a Guest", () => {
    render(
      <SessionRolesProvider
        roles={{
          tenantRole: "guest",
          platformMaintainer: false,
          workspaceRoles: { [workspace.id]: "guest" },
        }}
        actorId="user:g"
        displayName="Guest"
      >
        <FilesUploadControl api={fakeApi()} workspace={workspace} onUploaded={vi.fn()} />
      </SessionRolesProvider>,
    );
    expect(screen.queryByRole("button", { name: /Upload files/ })).toBeNull();
  });
});
