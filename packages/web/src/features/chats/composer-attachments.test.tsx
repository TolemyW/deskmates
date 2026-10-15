// @vitest-environment jsdom
// T0: chat composer attachments (ADR-0014 amendment A5 decisions 41 and 42). Files dropped on the
// chat pane, pasted into the composer or chosen with the paperclip upload at once and wait as
// chips with progress; Send carries their upload ids and clears them. A failed chip blocks Send
// until it is retried or removed, removing a chip deletes nothing, and dragged or pasted text
// stays text. An upload alone sends nothing.

import type { WorkspaceUpload } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  type RecordedCall,
  THREAD_ID,
  fakeFetch,
  installFakeEventSource,
  members,
  message,
  run,
  thread,
  workspaceView,
} from "../../test-support/fixtures.js";
import { ChatPane } from "./chat-pane.js";
import { pastedFiles } from "./composer-attachments.js";

beforeEach(installFakeEventSource);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = "/api/workspaces/ws_1/uploads";

/** The chat routes plus an in-memory upload session store; `failNextPart` fails one part. */
function setup(options: { failNextPart?: boolean } = {}) {
  const sessions = new Map<string, WorkspaceUpload>();
  let failNext = options.failNextPart === true;
  let counter = 0;
  const uploadRoute = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!url.startsWith(BASE)) return undefined;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === BASE && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; sizeBytes: number };
      const existing = [...sessions.values()].find((s) => s.label === body.name);
      if (existing) return json(200, existing);
      counter += 1;
      const upload: WorkspaceUpload = {
        id: `upl_${String(counter).padStart(32, "0")}`,
        workspaceId: "ws_1" as WorkspaceUpload["workspaceId"],
        state: "receiving",
        name: body.name,
        label: body.name,
        sizeBytes: body.sizeBytes,
        receivedBytes: 0,
        uploader: "user:u1",
        createdAt: "2026-10-14T00:00:00.000Z",
        updatedAt: "2026-10-14T00:00:00.000Z",
      };
      sessions.set(upload.id, upload);
      return json(201, upload);
    }
    const match = /^\/api\/workspaces\/ws_1\/uploads\/([^/?]+)(\/parts|\/complete)?/.exec(url);
    const upload = sessions.get(match?.[1] ?? "");
    if (!upload) return json(404, { code: "not_found", message: "none", details: {} });
    if (match?.[2] === "/parts") {
      if (failNext) {
        failNext = false;
        return json(507, { code: "storage_exhausted", message: "full", details: {} });
      }
      upload.receivedBytes = upload.sizeBytes;
      return json(200, upload);
    }
    if (match?.[2] === "/complete") {
      upload.state = "completed";
      upload.path = `/work/uploads/2026-10-14/${upload.name}`;
      return json(200, upload);
    }
    return json(200, upload);
  };
  const chat = fakeFetch({
    "GET /api/threads/thr_1": { thread, members },
    "GET /api/workspaces/ws_1": workspaceView(),
    "GET /api/threads/thr_1/messages": { messages: [] },
    "GET /api/runs?threadId=thr_1": { runs: [] },
    "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [] },
    "GET /api/approvals?status=decided&threadId=thr_1": { approvals: [] },
    "POST /api/threads/thr_1/messages": (call: RecordedCall) => ({
      message: message(1, "human", String((call.body as { body?: string }).body ?? "")),
      runs: [run()],
    }),
  });
  const uploads: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await uploadRoute(input, init);
    if (answer) {
      uploads.push(`${init?.method ?? "GET"} ${String(input)}`);
      return answer;
    }
    return chat.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls: chat.calls, uploads };
}

const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST");
const chips = () => screen.queryAllByRole("listitem").filter((li) => li.matches(".composer-chip"));

async function openPane(fetch: typeof globalThis.fetch) {
  const view = render(<ChatPane threadId={THREAD_ID} api={createApiClient({ fetch })} />);
  const box = await screen.findByLabelText("Message");
  // The composer needs the thread's workspace before it accepts files.
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  const pane = view.container.querySelector("section.chat") as HTMLElement;
  return { box, pane };
}

describe("pastedFiles", () => {
  it("names a nameless or generic clipboard image and keeps a real file name", () => {
    const now = new Date("2026-10-14T09:08:07.123Z");
    const named = new File(["a"], "notes.txt", { type: "text/plain" });
    const shot = new File(["png"], "image.png", { type: "image/png" });
    const blank = new File(["jpg"], "", { type: "image/jpeg" });
    const names = pastedFiles({ files: [named, shot, blank] as unknown as FileList }, now).map(
      (f) => f.name,
    );
    expect(names).toEqual([
      "notes.txt",
      "pasted-20261014-090807-2.png",
      "pasted-20261014-090807-3.jpg",
    ]);
    expect(pastedFiles(null)).toEqual([]);
  });
});

describe("chat composer attachments", () => {
  it("uploads dropped and pasted files as chips and sends their ids with a blank text", async () => {
    const { fetch, calls, uploads } = setup();
    const { box, pane } = await openPane(fetch);

    fireEvent.dragEnter(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByText("Drop files to attach them")).toBeTruthy();
    fireEvent.drop(pane, {
      dataTransfer: { types: ["Files"], files: [new File(["hello"], "notes.txt")] },
    });
    expect(screen.queryByText("Drop files to attach them")).toBeNull();
    fireEvent.paste(box, {
      clipboardData: { files: [new File(["png"], "image.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(chips()).toHaveLength(2));
    await waitFor(() =>
      expect(chips().every((chip) => chip.getAttribute("data-state") === "completed")).toBe(true),
    );
    expect(chips()[1]?.textContent).toMatch(/^pasted-\d{8}-\d{6}\.png/);
    // Uploading alone posted nothing.
    expect(posts(calls)).toHaveLength(0);

    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toEqual({
      body: "",
      attachments: [
        { uploadId: `upl_${"1".padStart(32, "0")}` },
        { uploadId: `upl_${"2".padStart(32, "0")}` },
      ],
    });
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(uploads.filter((u) => u.endsWith("/complete"))).toHaveLength(2);
  });

  it("keeps pasted and dragged text as text", async () => {
    const { fetch, uploads } = setup();
    const { box, pane } = await openPane(fetch);
    fireEvent.paste(box, { clipboardData: { files: [] } });
    fireEvent.dragEnter(pane, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(screen.queryByText("Drop files to attach them")).toBeNull();
    fireEvent.drop(pane, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(chips()).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it("a failed chip blocks Send until it is retried; Remove drops a chip without deleting the file", async () => {
    const { fetch, calls, uploads } = setup({ failNextPart: true });
    const { box } = await openPane(fetch);
    fireEvent.change(box, { target: { value: "see attached" } });
    fireEvent.change(screen.getByTestId("composer-attach-input"), {
      target: { files: [new File(["abc"], "report.csv")] },
    });
    await waitFor(() => expect(chips()[0]?.getAttribute("data-state")).toBe("failed"));
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry uploading report.csv" }));
    await waitFor(() => expect(chips()[0]?.getAttribute("data-state")).toBe("completed"));
    expect(send.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove report.csv from this message" }));
    expect(chips()).toHaveLength(0);
    expect(uploads.some((u) => u.startsWith("DELETE"))).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toEqual({ body: "see attached" });
  });
});
