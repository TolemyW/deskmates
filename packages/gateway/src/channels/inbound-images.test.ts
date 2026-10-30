// T1, ADR-0047 decision 12: an image a person sends through an ABI-2 channel enters the workspace
// exactly as a Web upload does (an upload row by the channel author, the bytes under
// /work/uploads/<date>/, a `file.upload` audit row, the attachment on the person's message), with
// a name whose extension follows its type so the run's vision policy applies to it. What cannot be
// stored is refused and counted for the plugin's notice; nothing is simulated.

import { CHANNEL_INBOUND_IMAGE_MAX_BYTES, type ThreadId } from "@deskmates/contracts";
import { FakeChannelProvider } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { type ChannelFixture, startChannelFixture } from "../test-support/channel-connections.js";

let fx: ChannelFixture | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function connected() {
  const fake = new FakeChannelProvider();
  fake.addAccount("tok-a", { accountId: "1", label: "A" });
  fx = await startChannelFixture([fake]);
  const id = (await fx.connect({ pluginId: "fakechat", token: "tok-a", botId: fx.alice.id })).json
    .connection.id;
  return { f: fx, fake, id };
}

describe("inbound images (ADR-0047 decision 12)", { timeout: 30_000 }, () => {
  it("stores an image like a Web upload and attaches it to the person's message", async () => {
    const { f, fake, id } = await connected();
    await f.running();
    const posted = await fake.deliver(id, {
      senderId: "u1",
      externalId: "img-1",
      body: "what is this?",
      images: [{ name: "IMG_0042", mimeType: "image/jpeg", bytes: PNG }],
    });
    if (posted.status !== "posted") throw new Error(`not posted: ${posted.status}`);
    expect(posted.imagesRefused).toBe(0);
    const [attachment] = posted.message.attachments;
    expect(attachment).toMatchObject({
      name: "IMG_0042.jpg",
      mimeType: "image/jpeg",
      sizeBytes: PNG.byteLength,
    });
    expect(attachment?.ref).toMatch(/^\/work\/uploads\/\d{4}-\d{2}-\d{2}\/IMG_0042\.jpg$/);
    expect(f.uploads.get(attachment?.ref ?? "")).toBe(PNG.byteLength);
    const upload = f.ctx.db
      .prepare("SELECT uploader, state, path FROM workspace_uploads WHERE id = ?")
      .get(attachment?.uploadId);
    expect(upload).toEqual({ uploader: "fakechat:u1", state: "completed", path: attachment?.ref });
    expect(
      f.ctx.db.prepare("SELECT actor FROM audit_events WHERE action = 'file.upload'").get(),
    ).toEqual({ actor: "fakechat:u1" });

    // A redelivery of the same event stores nothing twice and posts nothing.
    const again = await fake.deliver(id, {
      senderId: "u1",
      externalId: "img-1",
      body: "what is this?",
      images: [{ name: "IMG_0042", mimeType: "image/jpeg", bytes: PNG }],
    });
    expect(again.status).toBe("duplicate");
    expect(
      (f.ctx.db.prepare("SELECT count(*) AS n FROM workspace_uploads").get() as { n: number }).n,
    ).toBe(1);
  });

  it("refuses other types, oversize images and a stopped workspace, and posts no empty message", async () => {
    const { f, fake, id } = await connected();
    // The workspace is not running: the text goes through, the image is refused.
    const stopped = await fake.deliver(id, {
      senderId: "u1",
      externalId: "a",
      body: "caption",
      images: [{ name: "p.png", mimeType: "image/png", bytes: PNG }],
    });
    expect(stopped).toMatchObject({ status: "posted", imagesRefused: 1 });
    if (stopped.status === "posted") expect(stopped.message.attachments).toEqual([]);

    await f.running();
    const mixed = await fake.deliver(id, {
      senderId: "u1",
      externalId: "b",
      body: "two files",
      images: [
        { name: "scan.tiff", mimeType: "image/tiff", bytes: PNG },
        {
          name: "huge.png",
          mimeType: "image/png",
          bytes: new Uint8Array(CHANNEL_INBOUND_IMAGE_MAX_BYTES + 1),
        },
        { name: "ok.png", mimeType: "image/png", bytes: PNG },
      ],
    });
    expect(mixed).toMatchObject({ status: "posted", imagesRefused: 2 });
    if (mixed.status === "posted")
      expect(mixed.message.attachments.map((a) => a.name)).toEqual(["ok.png"]);

    const threads = (f.ctx.db.prepare("SELECT count(*) AS n FROM threads").get() as { n: number })
      .n;
    const messages = (
      f.ctx.db.prepare("SELECT count(*) AS n FROM thread_messages").get() as { n: number }
    ).n;
    const onlyRefused = await fake.deliver(id, {
      senderId: "u3",
      externalId: "c",
      body: "  ",
      images: [{ name: "v.gif", mimeType: "video/mp4", bytes: PNG }],
    });
    expect(onlyRefused).toEqual({ status: "empty", imagesRefused: 1 });
    expect((f.ctx.db.prepare("SELECT count(*) AS n FROM threads").get() as { n: number }).n).toBe(
      threads,
    );
    expect(
      (f.ctx.db.prepare("SELECT count(*) AS n FROM thread_messages").get() as { n: number }).n,
    ).toBe(messages);
    if (mixed.status === "posted")
      expect(f.ctx.threads.get(mixed.thread.id as ThreadId)?.channel).toBe("fakechat");
  });
});
