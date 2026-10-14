// T1: ADR-0014 amendments A2 and A4, the workspace Files collection. Built from SQLite only:
// verified publications, human-supplied attachments and legacy delivered task artifacts. These
// cases seed deliveries and messages through the stores and read the route.

import {
  type Attachment,
  type BotDefinition,
  CSRF_HEADER,
  FILE_COLLECTION_PAGE_SIZE,
  FILE_DIGEST_CHECK,
  type RunId,
  type Thread,
  type WorkspaceFileCollectionPage,
  type WorkspaceFileItem,
  type WorkspaceId,
} from "@deskmates/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayContext } from "../context.js";
import { FileCollection } from "../files/file-collection.js";
import type { VerifiedFile } from "../files/file-verification.js";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";
import { FIXTURE_PASSWORD, seedTenant } from "../test-support/tenants.js";
import { registerErrorHandler } from "./errors.js";
import { registerFileCollectionRoutes } from "./file-collection-routes.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

const auth = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };

async function setup() {
  const provider = new FakeProvider();
  const app = buildGateway(
    testConfig({
      secretsKey: Buffer.alloc(32, 7).toString("base64"),
      auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
    }),
    provider,
    { surface: "combined-test", startCron: false },
  );
  apps.push(app);
  await app.ready();
  app.deskmates.scheduler.stop();
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name: "files", sandboxProvider: "docker" });
  const nova = ctx.bots.create({ name: "nova", role: "writer", workspaceId: workspace.id });
  const atlas = ctx.bots.create({ name: "atlas", role: "analyst", workspaceId: workspace.id });
  const thread = ctx.threads.create({
    workspaceId: workspace.id,
    botIds: [nova.id, atlas.id],
    title: "Weekly report",
  });
  const other = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
  const stranger = ctx.bots.create({ name: "stranger", role: "x", workspaceId: other.id });
  const otherThread = ctx.threads.create({ workspaceId: other.id, botIds: [stranger.id] });
  return { app, ctx, provider, workspace, nova, atlas, thread, other, stranger, otherThread };
}

function runFor(ctx: GatewayContext, bot: BotDefinition, thread: Thread): RunId {
  return ctx.runs.create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
  }).id;
}

function botSays(
  ctx: GatewayContext,
  bot: BotDefinition,
  thread: Thread,
  body: string,
  attachments: Attachment[] = [],
): RunId {
  const runId = runFor(ctx, bot, thread);
  ctx.messages.append({
    threadId: thread.id,
    authorKind: "bot",
    authorId: bot.id,
    body,
    attachments,
    runId,
  });
  return runId;
}

function humanAttaches(ctx: GatewayContext, thread: Thread, attachments: Attachment[]): void {
  ctx.messages.append({
    threadId: thread.id,
    authorKind: "human",
    authorId: "web",
    body: "Here is the input",
    attachments,
  });
}

function verifiedFor(paths: string[], sha = "a"): Map<string, VerifiedFile> {
  return new Map(
    paths.map((path) => [
      path,
      {
        path,
        sizeBytes: 42,
        sha256: sha.repeat(64).slice(0, 64),
        check: FILE_DIGEST_CHECK,
        checkedAt: new Date().toISOString(),
      },
    ]),
  );
}

/** A bot's formal delivery whose files the server verified (the verification is faked here). */
function delivers(
  ctx: GatewayContext,
  bot: BotDefinition,
  thread: Thread,
  paths: string[],
  opts: { title?: string; outstanding?: string[]; sha?: string; taskId?: string } = {},
) {
  const taskId =
    opts.taskId ??
    ctx.tasks.create(thread.workspaceId, { title: opts.title ?? "Report", threadIds: [thread.id] })
      .id;
  const runId = runFor(ctx, bot, thread);
  const result = ctx.tasks.deliver(
    runId,
    {
      taskId,
      summary: "Done",
      artifacts: paths.map((path) => ({ label: `Label ${path}`, path })),
      ...(opts.outstanding ? { outstanding: opts.outstanding } : {}),
    },
    verifiedFor(paths, opts.sha),
  );
  return { ...result, runId };
}

function attachment(ref: string, name = ref.slice(ref.lastIndexOf("/") + 1)): Attachment {
  return { name, mimeType: "text/plain", ref };
}

async function list(
  app: Awaited<ReturnType<typeof setup>>["app"],
  workspaceId: string,
  query = "",
): Promise<WorkspaceFileCollectionPage> {
  const response = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspaceId}/assets${query}`,
    headers: auth,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as WorkspaceFileCollectionPage;
}

const paths = (page: WorkspaceFileCollectionPage): string[] =>
  page.items.map((item) => item.path).sort();

const item = (page: WorkspaceFileCollectionPage, path: string): WorkspaceFileItem => {
  const found = page.items.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`${path} not listed`);
  return found;
};

describe("GET /api/workspaces/:id/assets", () => {
  it("lists publications, human inputs and legacy deliveries; never chat mentions", async () => {
    const { app, ctx, workspace, nova, thread } = await setup();
    delivers(ctx, nova, thread, ["/work/report.md"]);
    // Intermediate work in chat: bot attachments, bot paths, artifacts of undelivered tasks.
    botSays(ctx, nova, thread, "Chart attached", [attachment("/home/nova/chart.png")]);
    botSays(ctx, nova, thread, "Draft is at /work/drafts/notes.md.");
    ctx.tasks.create(workspace.id, {
      title: "Planned",
      artifacts: [{ label: "Draft", path: "/work/draft.md" }],
    });
    humanAttaches(ctx, thread, [attachment("/work/brief.pdf")]);
    ctx.messages.append({
      threadId: thread.id,
      authorKind: "human",
      authorId: "web",
      body: "Please write /work/requested.md",
    });
    ctx.messages.append({
      threadId: thread.id,
      authorKind: "system",
      authorId: "",
      body: "Approve writing /work/approval.md?",
      attachments: [attachment("/work/system-attachment.md")],
    });
    const page = await list(app, workspace.id);
    expect(page.scope).toBe("published-results-and-inputs");
    expect(paths(page)).toEqual(["/work/brief.pdf", "/work/report.md"]);
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
    expect(item(page, "/work/report.md")).toMatchObject({
      kind: "documents",
      name: "report.md",
      source: "bot",
      verification: "verified",
    });
    expect(item(page, "/work/brief.pdf")).toMatchObject({
      source: "uploaded",
      verification: "input",
    });
    expect(item(page, "/work/brief.pdf").publication).toBeUndefined();
  });

  it("drops protected and malformed paths and other workspaces' homes", async () => {
    const { app, ctx, workspace, thread } = await setup();
    humanAttaches(ctx, thread, [
      attachment("/profile/Cookies"),
      attachment("/work/../profile/x"),
      attachment("/etc/passwd"),
      attachment("/home/stranger/secret.md"),
      attachment("/work/my file.md"),
      attachment("/work/"),
      attachment("https://example.test/x.html"),
      attachment("/work/ok.html"),
    ]);
    expect(paths(await list(app, workspace.id))).toEqual(["/work/ok.html"]);
  });

  it("carries the checked version, the task and its delivery kind", async () => {
    const { app, ctx, workspace, nova, thread } = await setup();
    const { task, runId } = delivers(ctx, nova, thread, ["/work/out.csv"], { title: "Numbers" });
    const out = item(await list(app, workspace.id), "/work/out.csv");
    expect(out.publication).toMatchObject({
      taskId: task.id,
      taskTitle: "Numbers",
      taskDeleted: false,
      deliveryKind: "complete",
      runId,
      botId: nova.id,
      botName: "nova",
      label: "Label /work/out.csv",
      sizeBytes: 42,
      sha256: "a".repeat(64),
      check: FILE_DIGEST_CHECK,
      supersededCount: 0,
    });
    expect(out.references[0]).toMatchObject({ kind: "publication", usedInDelivery: true });
    // The list reads no bytes, so it claims no current size or modification time (decision 12).
    expect(Object.keys(out).sort()).toEqual([
      "kind",
      "lastReferencedAt",
      "name",
      "path",
      "publication",
      "referenceCount",
      "references",
      "source",
      "verification",
    ]);
  });

  it("publishes once per digest and supersedes on a new digest", async () => {
    const { app, ctx, workspace, nova, thread } = await setup();
    const first = delivers(ctx, nova, thread, ["/work/r.md"], { sha: "a" });
    delivers(ctx, nova, thread, ["/work/r.md"], { sha: "a", taskId: first.task.id });
    const once = await list(app, workspace.id);
    expect(once.total).toBe(1);
    expect(
      ctx.db.prepare("SELECT count(*) AS n FROM file_publications").get() as { n: number },
    ).toEqual({ n: 1 });
    delivers(ctx, nova, thread, ["/work/r.md"], { sha: "b", taskId: first.task.id });
    const replaced = item(await list(app, workspace.id), "/work/r.md");
    expect(replaced.publication?.sha256).toBe("b".repeat(64));
    expect(replaced.publication?.supersededCount).toBe(1);
  });

  it("lists a partial delivery's results without completing the task", async () => {
    const { app, ctx, workspace, nova, thread } = await setup();
    const { task } = delivers(ctx, nova, thread, ["/work/part.md"], {
      outstanding: ["Illustrated report"],
    });
    expect(task.status).toBe("in_progress");
    const part = item(await list(app, workspace.id), "/work/part.md");
    expect(part.publication?.deliveryKind).toBe("partial");
  });

  it("keeps legacy delivered artifacts honestly unverified", async () => {
    const { app, ctx, workspace } = await setup();
    const task = ctx.tasks.create(workspace.id, {
      title: "Legacy",
      artifacts: [{ label: "Old", path: "/work/old.md" }],
    });
    ctx.tasks.update(workspace.id, task.id, { version: 1, status: "delivered" });
    const accepted = ctx.tasks.accept(workspace.id, task.id, { version: 2 }, "human:web");
    const page = await list(app, workspace.id);
    expect(item(page, "/work/old.md")).toMatchObject({
      verification: "unverified",
      source: "unknown",
    });
    expect(item(page, "/work/old.md").publication).toBeUndefined();
    expect(accepted.status).toBe("accepted");
    expect(JSON.stringify(page)).not.toMatch(/accept/i);
  });

  it("keeps publications of a deleted task and names it deleted", async () => {
    const { app, ctx, workspace, nova, thread } = await setup();
    const { task } = delivers(ctx, nova, thread, ["/work/kept.md"]);
    ctx.tasks.softDelete(workspace.id, task.id, { version: task.version }, "human:web");
    const kept = item(await list(app, workspace.id), "/work/kept.md");
    expect(kept.publication?.taskDeleted).toBe(true);
  });

  it("pages 25 at a time, newest first", async () => {
    const { app, ctx, workspace, thread } = await setup();
    for (let i = 0; i < 30; i++)
      humanAttaches(ctx, thread, [attachment(`/work/f${String(i).padStart(2, "0")}.md`)]);
    const first = await list(app, workspace.id);
    expect(first.limit).toBe(FILE_COLLECTION_PAGE_SIZE);
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(30);
    const second = await list(app, workspace.id, "?offset=25");
    expect(second.items).toHaveLength(5);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((entry) => entry.path)).size).toBe(30);
    const times = all.map((entry) => entry.lastReferencedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("filters by type and source and searches paths and labels", async () => {
    const { app, ctx, workspace, nova, thread } = await setup();
    delivers(ctx, nova, thread, [
      "/work/site/index.html",
      "/work/a.png",
      "/work/b.md",
      "/work/c.bin",
    ]);
    humanAttaches(ctx, thread, [attachment("/work/brief.md", "Quarterly brief")]);
    expect(paths(await list(app, workspace.id, "?type=web"))).toEqual(["/work/site/index.html"]);
    expect(paths(await list(app, workspace.id, "?type=images"))).toEqual(["/work/a.png"]);
    expect(paths(await list(app, workspace.id, "?type=documents"))).toEqual([
      "/work/b.md",
      "/work/brief.md",
    ]);
    expect(paths(await list(app, workspace.id, "?type=other"))).toEqual(["/work/c.bin"]);
    expect(paths(await list(app, workspace.id, "?type=documents&source=bot"))).toEqual([
      "/work/b.md",
    ]);
    expect(paths(await list(app, workspace.id, "?source=uploaded"))).toEqual(["/work/brief.md"]);
    expect(paths(await list(app, workspace.id, "?q=QUARTERLY"))).toEqual(["/work/brief.md"]);
    expect(paths(await list(app, workspace.id, "?q=site/"))).toEqual(["/work/site/index.html"]);
  });

  it("computes standard facets by applying every other active filter", async () => {
    const { app, ctx, workspace, nova, thread } = await setup();
    delivers(ctx, nova, thread, [
      "/work/a.png",
      "/work/b.md",
      "/work/site/index.html",
      "/work/c.bin",
    ]);
    humanAttaches(ctx, thread, [attachment("/work/human.md", "Human brief")]);
    const all = await list(app, workspace.id);
    expect(all.facets).toEqual({
      types: { documents: 2, images: 1, web: 1, other: 1 },
      sources: { bot: 4, uploaded: 1, unknown: 0 },
    });
    const selectedType = await list(app, workspace.id, "?type=documents");
    expect(selectedType.total).toBe(2);
    expect(selectedType.facets.types).toEqual(all.facets.types);
    expect(selectedType.facets.sources).toEqual({ bot: 1, uploaded: 1, unknown: 0 });
    const selectedSource = await list(app, workspace.id, "?source=bot");
    expect(selectedSource.total).toBe(4);
    expect(selectedSource.facets.types).toEqual({ documents: 1, images: 1, web: 1, other: 1 });
    expect(selectedSource.facets.sources).toEqual(all.facets.sources);
  });

  it.each([
    "?limit=101",
    "?limit=0",
    "?offset=-1",
    "?type=pdf",
    "?source=human",
    `?q=${"x".repeat(201)}`,
  ])("refuses %s", async (query) => {
    const { app, workspace } = await setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/assets${query}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("validation");
  });

  it("keeps each workspace's references to itself", async () => {
    const { app, ctx, workspace, nova, thread, other, stranger, otherThread } = await setup();
    delivers(ctx, nova, thread, ["/work/mine.md"]);
    delivers(ctx, stranger, otherThread, ["/work/theirs.md", "/home/stranger/notes.md"]);
    expect(paths(await list(app, workspace.id))).toEqual(["/work/mine.md"]);
    expect(paths(await list(app, other.id))).toEqual([
      "/home/stranger/notes.md",
      "/work/theirs.md",
    ]);
    const missing = await app.inject({
      method: "GET",
      url: "/api/workspaces/ws_missing/assets",
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("never touches the sandbox, even for a stopped workspace", async () => {
    const { app, ctx, provider, workspace, nova, thread } = await setup();
    delivers(ctx, nova, thread, ["/work/a.md"]);
    const attach = vi.spyOn(provider, "attach");
    const ensure = vi.spyOn(ctx.sandboxes, "ensure");
    const peek = vi.spyOn(ctx.sandboxes, "peek");
    expect((await list(app, workspace.id)).total).toBe(1);
    expect(attach).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(peek).not.toHaveBeenCalled();
    expect(provider.execCalls).toEqual([]);
  });

  it("lets a Member read and hides another tenant's workspace", async () => {
    const { app, ctx } = await setup();
    const A = await seedTenant(ctx, "A");
    const B = await seedTenant(ctx, "B");
    await ctx.auth.createUser({
      loginName: "member-a",
      displayName: "Member A",
      password: FIXTURE_PASSWORD,
      role: "member",
      tenantId: A.tenantId,
    });
    const { token } = await ctx.auth.login("member-a", FIXTURE_PASSWORD, "member-a");
    const { csrfTokenFor } = await import("../auth/tokens.js");
    const as = (url: string) =>
      app.inject({
        method: "GET",
        url,
        headers: {
          cookie: `__Host-deskmates-session=${token}`,
          host: "gw.test",
          origin: "http://gw.test",
          [CSRF_HEADER]: csrfTokenFor(token),
        },
      });
    expect((await as(`/api/workspaces/${A.ids.workspace}/assets`)).statusCode).toBe(200);
    expect((await as(`/api/workspaces/${B.ids.workspace}/assets`)).statusCode).toBe(404);
  });

  it("caps the scan and says so", async () => {
    const { ctx, workspace, thread } = await setup();
    for (let i = 0; i < 3; i++) humanAttaches(ctx, thread, [attachment(`/work/f${i}.md`)]);
    const query = { offset: 0, limit: 25, type: "all", source: "all", q: "" } as const;
    const collection = new FileCollection(ctx.db);
    const capped = collection.list(workspace.id as WorkspaceId, query, { scanLimit: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(2);
    expect(collection.list(workspace.id as WorkspaceId, query).truncated).toBe(false);
  });

  it("logs one line per listing", async () => {
    const { ctx, workspace, nova, thread } = await setup();
    delivers(ctx, nova, thread, ["/work/a.md"]);
    const app = Fastify();
    apps.push(app);
    registerErrorHandler(app);
    const log = vi.fn();
    registerFileCollectionRoutes(app, ctx, { log });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/assets?type=documents&q=a`,
    });
    expect(response.statusCode).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("workspace files listed", {
      workspaceId: workspace.id,
      actor: "operator",
      type: "documents",
      source: "all",
      searched: true,
      offset: 0,
      total: 1,
      truncated: false,
    });
  });
});
