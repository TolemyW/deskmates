// T1: ADR-0014 amendment A5 workspace uploads. The fake provider plays the sidecar's `file-write`
// command over an in-memory volume, so these cases cover what the Gateway does with each answer;
// the path and symlink policy itself is proven on a real filesystem in
// packages/sidecar/src/file-write.test.ts.

import { type Hash, createHash, randomBytes } from "node:crypto";
import {
  type ExecRequest,
  type ExecResult,
  WORKSPACE_FILE_UPLOAD_PART_BYTES,
  type WorkspaceFileCollectionPage,
  type WorkspaceUpload,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { TEST_OPERATOR_TOKEN } from "../test-support/harness.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
});

const PART = WORKSPACE_FILE_UPLOAD_PART_BYTES;
const MIB = 1024 * 1024;

/** An in-memory `/work/uploads` that answers `deskmates-sidecar file-write` like the real one. */
function fakeVolume(harness: Harness) {
  const partial = new Map<string, { size: number; hash: Hash }>();
  const finals = new Set<string>();
  const state = {
    maxStdin: 0,
    ops: [] as string[],
    failNext: undefined as string | undefined,
    gate: undefined as Promise<void> | undefined,
  };
  const out = (body: unknown, exitCode = 0): ExecResult => ({
    exitCode,
    stdout: `${JSON.stringify(body)}\n`,
    stderr: "",
    timedOut: false,
  });
  const exec = vi
    .spyOn(harness.provider, "exec")
    .mockImplementation(async (_handle, req: ExecRequest): Promise<ExecResult> => {
      if (req.cmd.join(" ") !== "deskmates-sidecar file-write") return out({}, 0);
      const stdin = req.stdin ?? "";
      state.maxStdin = Math.max(state.maxStdin, stdin.length);
      const r = JSON.parse(stdin) as {
        op: string;
        uploadId: string;
        offset?: number;
        base64?: string;
        sizeBytes?: number;
        dir?: string;
        name?: string;
      };
      state.ops.push(r.op);
      const current = partial.get(r.uploadId);
      if (state.failNext) {
        const error = state.failNext;
        state.failNext = undefined;
        return out({ error, message: "refused", receivedBytes: current?.size }, 1);
      }
      switch (r.op) {
        case "begin":
          partial.set(r.uploadId, { size: 0, hash: createHash("sha256") });
          return out({ op: "begin", receivedBytes: 0 });
        case "append": {
          if (state.gate) await state.gate;
          if (!current) return out({ error: "not_found", message: "gone" }, 1);
          if (current.size !== r.offset)
            return out({ error: "offset_mismatch", message: "x", receivedBytes: current.size }, 1);
          const bytes = Buffer.from(r.base64 as string, "base64");
          current.hash.update(bytes);
          current.size += bytes.length;
          return out({ op: "append", receivedBytes: current.size });
        }
        case "commit": {
          if (!current) return out({ error: "not_found", message: "gone" }, 1);
          let n = 1;
          let path: string;
          do {
            const name = n === 1 ? r.name : (r.name as string).replace(/(\.[^.]*)?$/, `-${n}$1`);
            path = `/work/uploads/${r.dir}/${name}`;
            n += 1;
          } while (finals.has(path));
          finals.add(path);
          partial.delete(r.uploadId);
          return out({
            op: "commit",
            path,
            sizeBytes: current.size,
            sha256: current.hash.digest("hex"),
          });
        }
        case "abort":
          return out({ op: "abort", removed: partial.delete(r.uploadId) });
        default:
          return out({ error: "validation", message: "x" }, 1);
      }
    });
  return { exec, state, partial };
}

async function running(harness: Harness, workspaceId: string): Promise<void> {
  const ctx = harness.app.deskmates.ctx;
  await ctx.sandboxes.ensure(ctx.workspaces.mustGet(workspaceId as never));
}

/** Operator-credential request; `raw` sends bytes with their own content type. */
async function op(
  method: string,
  path: string,
  body?: unknown,
  raw?: { bytes: Uint8Array; contentType?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h?.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(raw ? { "content-type": raw.contentType ?? "application/octet-stream" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(raw ? { body: raw.bytes } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

const uploadsUrl = (workspaceId: string) => `/api/workspaces/${workspaceId}/uploads`;

/** Create, send every part in order and complete, all with the operator credential. */
async function uploadAll(workspaceId: string, name: string, bytes: Buffer) {
  const created = await op("POST", uploadsUrl(workspaceId), { name, sizeBytes: bytes.length });
  expect(created.status).toBe(201);
  const id = created.json.id as string;
  for (let offset = 0; offset < bytes.length; offset += PART) {
    const part = await op(
      "PUT",
      `${uploadsUrl(workspaceId)}/${id}/parts?offset=${offset}`,
      undefined,
      { bytes: bytes.subarray(offset, offset + PART) },
    );
    expect(part.status).toBe(200);
  }
  const done = await op("POST", `${uploadsUrl(workspaceId)}/${id}/complete`);
  expect(done.status).toBe(200);
  return done.json as unknown as WorkspaceUpload;
}

const count = (harness: Harness, table: string) =>
  (
    harness.app.deskmates.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;

describe("workspace uploads (ADR-0014 A5)", () => {
  it("roles: Members, Admins and Owners upload; Guests, strangers and other uploaders do not", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const ctx = harness.app.deskmates.ctx;
    const people = await seedRoles(harness);
    await running(harness, people.workspace.id);
    const volume = fakeVolume(harness);
    const base = uploadsUrl(people.workspace.id);

    // Decision 28: a Guest is refused before any row or byte.
    const guest = await people.guest.fetch("POST", base, { body: { name: "g.txt", sizeBytes: 1 } });
    expect(guest.status).toBe(403);
    expect(count(harness, "workspace_uploads")).toBe(0);
    expect(volume.exec).not.toHaveBeenCalled();

    for (const jar of [people.member, people.admin, people.owner]) {
      const created = await jar.json<WorkspaceUpload>("POST", base, {
        body: { name: "notes.txt", sizeBytes: 3 },
      });
      expect(created.status).toBe(201);
      const part = await jar.fetch("PUT", `${base}/${created.json.id}/parts?offset=0`, {
        raw: { bytes: Buffer.from("abc"), contentType: "application/octet-stream" },
      });
      expect(part.status).toBe(200);
      const done = await jar.json<WorkspaceUpload>("POST", `${base}/${created.json.id}/complete`);
      expect(done.status).toBe(200);
      expect(done.json.state).toBe("completed");
    }

    // Another workspace the Member does not belong to is the uniform 404.
    const other = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
    await running(harness, other.id);
    expect(
      (
        await people.member.fetch("POST", uploadsUrl(other.id), {
          body: { name: "x", sizeBytes: 1 },
        })
      ).status,
    ).toBe(404);

    // Another uploader's session: 404 for a Member, readable and cancellable by an Admin.
    const mine = await people.member.json<WorkspaceUpload>("POST", base, {
      body: { name: "mine.bin", sizeBytes: 4 },
    });
    const foreignPart = await people.otherMember.fetch(
      "PUT",
      `${base}/${mine.json.id}/parts?offset=0`,
      { raw: { bytes: Buffer.from("zz"), contentType: "application/octet-stream" } },
    );
    expect(foreignPart.status).toBe(404);
    expect((await people.otherMember.fetch("GET", `${base}/${mine.json.id}`)).status).toBe(404);
    expect((await people.admin.fetch("GET", `${base}/${mine.json.id}`)).status).toBe(200);
    expect(
      (
        await people.admin.fetch("PUT", `${base}/${mine.json.id}/parts?offset=0`, {
          raw: { bytes: Buffer.from("zz"), contentType: "application/octet-stream" },
        })
      ).status,
    ).toBe(404);

    // A stale role: demoted to Guest mid-upload, the next part is refused with no write.
    ctx.auth.users.updateMembership(DEFAULT_TENANT_ID, people.ids.mel as string, {
      role: "guest",
      workspaceId: people.workspace.id,
    });
    const writesBefore = volume.state.ops.length;
    const stale = await people.member.fetch("PUT", `${base}/${mine.json.id}/parts?offset=0`, {
      raw: { bytes: Buffer.from("abcd"), contentType: "application/octet-stream" },
    });
    expect(stale.status).toBe(401);
    await people.member.signIn("mel");
    const asGuest = await people.member.fetch("PUT", `${base}/${mine.json.id}/parts?offset=0`, {
      raw: { bytes: Buffer.from("abcd"), contentType: "application/octet-stream" },
    });
    expect(asGuest.status).toBe(403);
    // A removed person's session ends; nothing more is written either.
    ctx.auth.users.updateMembership(DEFAULT_TENANT_ID, people.ids.max as string, {
      status: "removed",
    });
    const removed = await people.otherMember.fetch("POST", base, {
      body: { name: "late.txt", sizeBytes: 1 },
    });
    expect(removed.status).toBe(401);
    expect(volume.state.ops.length).toBe(writesBefore);

    // An Admin may cancel another person's receiving upload.
    const cancelled = await people.admin.json<WorkspaceUpload>("DELETE", `${base}/${mine.json.id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.state).toBe("cancelled");
  });

  it("streams a large file in bounded parts, lists it as an uploaded input and audits it, with no side effects", async () => {
    h = await startHarness();
    const harness = h;
    const { workspace, thread } = await harness.seed();
    await running(harness, workspace.id);
    const volume = fakeVolume(harness);
    const runs = count(harness, "runs");
    const messages = count(harness, "thread_messages");
    const tasks = count(harness, "tasks");
    const knowledge = count(harness, "knowledge_docs");
    const memory = count(harness, "memory_entries");

    // Far above the 10 MiB cap that was proposed and never approved: no size refusal.
    const bytes = randomBytes(40 * MIB + 123);
    const done = await uploadAll(workspace.id, "../../季度 Report (final).csv", bytes);
    expect(done.path).toMatch(/^\/work\/uploads\/\d{4}-\d{2}-\d{2}\/Report_final\.csv$/);
    expect(done.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(done.label).toBe("../../季度 Report (final).csv");
    // One part per request, one container write per part: the Gateway never held the file.
    expect(volume.state.ops).toEqual([
      "begin",
      ...Array.from({ length: Math.ceil(bytes.length / PART) }, () => "append"),
      "commit",
    ]);
    expect(volume.state.maxStdin).toBeLessThan(Math.ceil(PART / 3) * 4 + 300);

    const files = await op("GET", `/api/workspaces/${workspace.id}/assets?source=uploaded`);
    const page = files.json as unknown as WorkspaceFileCollectionPage;
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      path: done.path,
      source: "uploaded",
      verification: "input",
      references: [
        {
          kind: "upload",
          uploadId: done.id,
          uploader: "human:web",
          sizeBytes: bytes.length,
          sha256: done.sha256,
          label: done.label,
        },
      ],
    });

    const audit = harness.app.deskmates.ctx.audit.list({ targetId: done.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "file.upload",
      actor: "human:web",
      after: { path: done.path, sizeBytes: bytes.length, sha256: done.sha256 },
    });

    // Decision 34: no run, message, task, Knowledge document or memory item.
    expect(count(harness, "runs")).toBe(runs);
    expect(count(harness, "thread_messages")).toBe(messages);
    expect(count(harness, "tasks")).toBe(tasks);
    expect(count(harness, "knowledge_docs")).toBe(knowledge);
    expect(count(harness, "memory_entries")).toBe(memory);
    expect(thread.id).toBeTruthy();
  });

  it("never overwrites: a second upload of the same name gets another path", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    await running(h, workspace.id);
    fakeVolume(h);
    const first = await uploadAll(workspace.id, "a.txt", Buffer.from("one"));
    const second = await uploadAll(workspace.id, "a.txt", Buffer.from("two"));
    expect(second.path).toBe(first.path?.replace("a.txt", "a-2.txt"));
    const page = (await op("GET", `/api/workspaces/${workspace.id}/assets`))
      .json as unknown as WorkspaceFileCollectionPage;
    expect(page.items.map((item) => item.path).sort()).toEqual([first.path, second.path].sort());
  });

  it("states offsets, sizes, concurrency, retries and cancellation truthfully", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    await running(h, workspace.id);
    const volume = fakeVolume(h);
    const base = uploadsUrl(workspace.id);
    const created = await op("POST", base, { name: "r.bin", sizeBytes: 6, idempotencyKey: "k-1" });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    // Retrying the create with the same key returns the same session.
    const again = await op("POST", base, { name: "r.bin", sizeBytes: 6, idempotencyKey: "k-1" });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(id);

    const part = (offset: number, text: string, contentType?: string) =>
      op("PUT", `${base}/${id}/parts?offset=${offset}`, undefined, {
        bytes: Buffer.from(text),
        ...(contentType ? { contentType } : {}),
      });
    expect((await part(0, "abc")).status).toBe(200);
    // A lost response: the client retries at a stale offset and learns the received count.
    const stale = await part(0, "abc");
    expect(stale.status).toBe(409);
    expect(stale.json.details).toMatchObject({
      reason: "upload_offset_mismatch",
      receivedBytes: 3,
    });
    // Past the declared size.
    const past = await part(3, "defg");
    expect(past.status).toBe(400);
    expect(past.json.details).toMatchObject({ reason: "upload_exceeds_declared_size" });
    // The client's content type decides nothing; only raw octet-stream parts are accepted.
    expect((await part(3, "def", "text/html")).status).toBe(415);
    // Completing early.
    const early = await op("POST", `${base}/${id}/complete`);
    expect(early.status).toBe(409);
    expect(early.json.details).toMatchObject({ reason: "upload_incomplete", receivedBytes: 3 });

    // Two parts at once: the second is refused while the first is written.
    let release = () => {};
    volume.state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = part(3, "def");
    await vi.waitFor(() => expect(volume.state.ops.at(-1)).toBe("append"));
    const busy = await part(3, "def");
    expect(busy.status).toBe(409);
    expect(busy.json.details).toMatchObject({ reason: "upload_busy" });
    release();
    volume.state.gate = undefined;
    expect((await slow).status).toBe(200);

    const done = await op("POST", `${base}/${id}/complete`);
    expect(done.status).toBe(200);
    // Completing again returns the same result and writes nothing.
    const opsBefore = volume.state.ops.length;
    const repeat = await op("POST", `${base}/${id}/complete`);
    expect(repeat.json).toEqual(done.json);
    expect(volume.state.ops.length).toBe(opsBefore);
    // A completed upload is not deleted through this route.
    const cancelDone = await op("DELETE", `${base}/${id}`);
    expect(cancelDone.status).toBe(409);

    // Cancel removes the partial file; later parts are refused.
    const second = await op("POST", base, { name: "c.bin", sizeBytes: 4 });
    const secondId = second.json.id as string;
    await op("PUT", `${base}/${secondId}/parts?offset=0`, undefined, { bytes: Buffer.from("ab") });
    const cancelled = await op("DELETE", `${base}/${secondId}`);
    expect(cancelled.json.state).toBe("cancelled");
    expect(volume.partial.has(secondId)).toBe(false);
    const afterCancel = await op("PUT", `${base}/${secondId}/parts?offset=2`, undefined, {
      bytes: Buffer.from("cd"),
    });
    expect(afterCancel.status).toBe(409);
    expect(afterCancel.json.details).toMatchObject({ reason: "upload_cancelled" });
  });

  it("refuses a part larger than one transfer unit", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    await running(h, workspace.id);
    fakeVolume(h);
    const base = uploadsUrl(workspace.id);
    const created = await op("POST", base, { name: "big.bin", sizeBytes: PART + 1 });
    // In-process: over a socket the Gateway answers 413 from the length and closes the stream.
    const response = await h.app.inject({
      method: "PUT",
      url: `${base}/${created.json.id}/parts?offset=0`,
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(PART + 1),
    });
    expect(response.statusCode).toBe(413);
  });

  it("reports a full disk as storage_exhausted and resumes from the kept length", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    await running(h, workspace.id);
    const volume = fakeVolume(h);
    const base = uploadsUrl(workspace.id);
    const created = await op("POST", base, { name: "d.bin", sizeBytes: 4 });
    const id = created.json.id as string;
    await op("PUT", `${base}/${id}/parts?offset=0`, undefined, { bytes: Buffer.from("ab") });
    volume.state.failNext = "storage_exhausted";
    const full = await op("PUT", `${base}/${id}/parts?offset=2`, undefined, {
      bytes: Buffer.from("cd"),
    });
    expect(full.status).toBe(507);
    expect(full.json).toMatchObject({ code: "storage_exhausted", details: { receivedBytes: 2 } });
    const status = await op("GET", `${base}/${id}`);
    expect(status.json).toMatchObject({ state: "receiving", receivedBytes: 2 });
    expect(
      (await op("PUT", `${base}/${id}/parts?offset=2`, undefined, { bytes: Buffer.from("cd") }))
        .status,
    ).toBe(200);
    expect((await op("POST", `${base}/${id}/complete`)).status).toBe(200);
  });

  it("applies a disclosed workspace quota only when one is configured", async () => {
    h = await startHarness({ fileUploadWorkspaceQuotaBytes: 10 });
    const { workspace } = await h.seed();
    await running(h, workspace.id);
    fakeVolume(h);
    const base = uploadsUrl(workspace.id);
    expect((await op("POST", base, { name: "a", sizeBytes: 6 })).status).toBe(201);
    const over = await op("POST", base, { name: "b", sizeBytes: 5 });
    expect(over.status).toBe(413);
    expect(over.json.details).toMatchObject({ reason: "workspace_upload_quota", quotaBytes: 10 });
  });

  it("refuses a stopped workspace without starting it, and expires idle sessions", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const volume = fakeVolume(h);
    const ensure = vi.spyOn(h.app.deskmates.ctx.sandboxes, "ensure");
    const stopped = await op("POST", uploadsUrl(workspace.id), { name: "a", sizeBytes: 1 });
    expect(stopped.status).toBe(404);
    expect(stopped.json.details).toMatchObject({ reason: "workspace_not_running" });
    expect(ensure).not.toHaveBeenCalled();
    expect(count(h, "workspace_uploads")).toBe(0);

    ensure.mockRestore();
    await running(h, workspace.id);
    const created = await op("POST", uploadsUrl(workspace.id), { name: "idle", sizeBytes: 2 });
    const id = created.json.id as string;
    h.app.deskmates.ctx.db
      .prepare("UPDATE workspace_uploads SET updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", id);
    const status = await op("GET", `${uploadsUrl(workspace.id)}/${id}`);
    expect(status.json.state).toBe("expired");
    expect(volume.partial.has(id)).toBe(false);
  });

  it("refuses names and sizes that are not valid", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    await running(h, workspace.id);
    fakeVolume(h);
    for (const body of [
      { name: "", sizeBytes: 1 },
      { name: "a", sizeBytes: -1 },
      { name: "a", sizeBytes: 1.5 },
      { name: "a".repeat(1025), sizeBytes: 1 },
      { name: "a", sizeBytes: 1, idempotencyKey: "has space" },
    ])
      expect((await op("POST", uploadsUrl(workspace.id), body)).status).toBe(400);
  });
});
