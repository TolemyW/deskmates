// @vitest-environment jsdom
// T0: attachment cards under a chat message (ADR-0014 amendment A5 decision 42). A workspace-path
// attachment is a card with its name, size, Preview and Download; any other reference stays a
// plain line; without a workspace there is nothing to open, so plain lines stand in.

import type { Attachment, WorkspaceId } from "@deskmates/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import { AttachmentCards, isWorkspacePathAttachment } from "./attachment-cards.js";

afterEach(cleanup);

const WS = "ws_1" as WorkspaceId;
const api = createApiClient({ fetch: (async () => new Response("{}")) as typeof fetch });

const upload: Attachment = {
  name: "Quarterly report.pdf",
  mimeType: "application/pdf",
  ref: "/work/uploads/2026-10-14/Quarterly_report.pdf",
  uploadId: `upl_${"a".repeat(32)}`,
  sizeBytes: 1536,
};
const artifact: Attachment = { name: "log", mimeType: "text/plain", ref: "https://x.test/log" };

describe("isWorkspacePathAttachment", () => {
  it("accepts /work and /home file paths only", () => {
    const of = (ref: string) => isWorkspacePathAttachment({ name: "x", mimeType: "x", ref });
    expect(of("/work/a.txt")).toBe(true);
    expect(of("/home/nova/out.csv")).toBe(true);
    expect(of("/work/")).toBe(false);
    expect(of("/work/../profile/Cookies")).toBe(false);
    expect(of("/profile/Cookies")).toBe(false);
    expect(of("work/a.txt")).toBe(false);
    expect(of("https://x.test/log")).toBe(false);
  });
});

describe("AttachmentCards", () => {
  it("shows a card with name, size, Preview and Download, and other references as text", () => {
    render(<AttachmentCards attachments={[upload, artifact]} api={api} workspaceId={WS} />);
    expect(screen.getByText("Quarterly report.pdf")).toBeTruthy();
    expect(screen.getByText("1.5 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: `Preview of ${upload.ref}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Download ${upload.ref}` })).toBeTruthy();
    expect(screen.getByText(/https:\/\/x\.test\/log/)).toBeTruthy();
  });

  // ADR-0014 A7 (issue #16): the card opens Files at the file's directory with the file selected.
  it("links the card to the same file in Files", () => {
    render(<AttachmentCards attachments={[upload, artifact]} api={api} workspaceId={WS} />);
    const link = screen.getByRole("link", { name: "Show Quarterly report.pdf in Files" });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("#/resources/files?")).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("workspace")).toBe(WS);
    expect(params.get("path")).toBe(upload.ref);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("falls back to plain lines before the workspace is known", () => {
    render(<AttachmentCards attachments={[upload]} api={api} workspaceId={undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Quarterly report\.pdf/)).toBeTruthy();
  });
});
