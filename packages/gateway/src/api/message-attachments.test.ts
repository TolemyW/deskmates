// T1: ADR-0014 amendment A5 decision 42. A person attaches their own completed uploads to a chat
// message by id; the Gateway stores the label, an extension type, the path, the id and the size,
// and refuses every other id with nothing stored or woken.

import type { ThreadMessage, WorkspaceFileCollectionPage, WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceUploads } from "../files/workspace-uploads.js";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const count = (harness: Harness, table: string) =>
  (
    harness.app.deskmates.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;

/** A completed upload recorded directly; the byte path is covered by file-upload-routes.test.ts. */
function completed(
  harness: Harness,
  workspaceId: WorkspaceId,
  uploader: string,
  name: string,
  sizeBytes = 42,
) {
  const uploads = new WorkspaceUploads(harness.app.deskmates.ctx.db);
  const upload = uploads.create({ workspaceId, uploader, name, label: `orig ${name}`, sizeBytes });
  return uploads.complete(workspaceId, upload.id, {
    path: `/work/uploads/2026-10-14/${name}`,
    sha256: "a".repeat(64),
    sizeBytes,
  });
}

describe("message attachments (ADR-0014 A5 decision 42)", () => {
  it("a Member attaches own completed uploads with a blank body; the message stores and lists them", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const { ctx } = harness.app.deskmates;
    const people = await seedRoles(harness);
    const thread = ctx.threads.create({
      workspaceId: people.workspace.id,
      botIds: [people.bot.id],
    });
    const me = `user:${people.ids.mel}`;
    const shot = completed(harness, people.workspace.id, me, "shot.png", 1234);
    const report = completed(harness, people.workspace.id, me, "report.weird");
    const runs = count(harness, "runs");

    const posted = await people.member.json<{ message: ThreadMessage }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      {
        body: {
          body: "",
          attachments: [{ uploadId: shot.id }, { uploadId: report.id }, { uploadId: shot.id }],
        },
      },
    );
    expect(posted.status).toBe(201);
    expect(posted.json.message.body).toBe("");
    expect(posted.json.message.attachments).toEqual([
      {
        name: "orig shot.png",
        mimeType: "image/png",
        ref: "/work/uploads/2026-10-14/shot.png",
        uploadId: shot.id,
        sizeBytes: 1234,
      },
      {
        name: "orig report.weird",
        mimeType: "application/octet-stream",
        ref: "/work/uploads/2026-10-14/report.weird",
        uploadId: report.id,
        sizeBytes: 42,
      },
    ]);
    // The message wakes the bot like any human message.
    expect(count(harness, "runs")).toBe(runs + 1);
    const stored = ctx.messages.listSlice(thread.id, { limit: 10 }).messages.at(-1);
    expect(stored?.attachments.map((a) => a.ref)).toEqual([shot.path, report.path]);

    // Files lists each path once, with the upload and the message as references.
    const files = await people.admin.json<WorkspaceFileCollectionPage>(
      "GET",
      `/api/workspaces/${people.workspace.id}/assets`,
    );
    const item = files.json.items.find((entry) => entry.path === shot.path);
    expect(item?.references.map((ref) => ref.kind).sort()).toEqual(
      ["message_attachment", "upload"].sort(),
    );

    // Once an Admin deletes the upload, the message attachment no longer lists it in Files.
    new WorkspaceUploads(ctx.db).markDeleted(people.workspace.id, shot.id, "user:x");
    const after = await people.admin.json<WorkspaceFileCollectionPage>(
      "GET",
      `/api/workspaces/${people.workspace.id}/assets`,
    );
    expect(after.json.items.map((entry) => entry.path)).not.toContain(shot.path);
  });

  it("refuses another person's, another workspace's, an unfinished, a deleted or an unknown upload, with nothing stored", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const { ctx } = harness.app.deskmates;
    const people = await seedRoles(harness);
    const thread = ctx.threads.create({
      workspaceId: people.workspace.id,
      botIds: [people.bot.id],
    });
    const me = `user:${people.ids.mel}`;
    const theirs = completed(harness, people.workspace.id, `user:${people.ids.max}`, "theirs.txt");
    const other = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
    const elsewhere = completed(harness, other.id, me, "elsewhere.txt");
    const uploads = new WorkspaceUploads(ctx.db);
    const receiving = uploads.create({
      workspaceId: people.workspace.id,
      uploader: me,
      name: "half.bin",
      label: "half.bin",
      sizeBytes: 9,
    });
    const deleted = completed(harness, people.workspace.id, me, "gone.txt");
    uploads.markDeleted(people.workspace.id, deleted.id, "user:x");
    const messages = count(harness, "thread_messages");
    const runs = count(harness, "runs");

    for (const uploadId of [
      theirs.id,
      elsewhere.id,
      receiving.id,
      deleted.id,
      `upl_${"f".repeat(32)}`,
      "../../etc/passwd",
    ]) {
      const refused = await people.member.json<{ details?: { reason?: string } }>(
        "POST",
        `/api/threads/${thread.id}/messages`,
        { body: { body: "see attached", attachments: [{ uploadId }] } },
      );
      expect(refused.status, uploadId).toBe(400);
      expect(refused.json.details?.reason).toBe("attachment_not_attachable");
    }
    // Too many entries and a blank body without attachments are refused too.
    const many = Array.from({ length: 21 }, () => ({ uploadId: theirs.id }));
    expect(
      (
        await people.member.fetch("POST", `/api/threads/${thread.id}/messages`, {
          body: { body: "x", attachments: many },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await people.member.fetch("POST", `/api/threads/${thread.id}/messages`, {
          body: { body: " ", attachments: [] },
        })
      ).status,
    ).toBe(400);

    // A Guest attaches nothing, even an upload made before a demotion.
    const guestUpload = completed(
      harness,
      people.workspace.id,
      `user:${people.ids.gus}`,
      "guest.txt",
    );
    const guest = await people.guest.json<{ details?: { reason?: string } }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: { body: "hi", attachments: [{ uploadId: guestUpload.id }] } },
    );
    expect(guest.status).toBe(400);
    expect(guest.json.details?.reason).toBe("attachment_not_attachable");

    expect(count(harness, "thread_messages")).toBe(messages);
    expect(count(harness, "runs")).toBe(runs);
  });
});
