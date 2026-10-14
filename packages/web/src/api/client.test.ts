// T0: the client builds exactly the URLs and bodies packages/gateway/docs/http-api.md documents,
// unwraps the response envelopes, and turns error bodies into ApiError.

import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_ID,
  BOT_ID,
  RUN_ID,
  type RecordedCall,
  THREAD_ID,
  WS_ID,
  approval,
  approvalRule,
  bot,
  browserLock,
  fakeFetch,
  members,
  message,
  run,
  runEvent,
  screenTicket,
  thread,
  usage,
  workspace,
  workspaceView,
} from "../test-support/fixtures.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./types.js";

describe("api client", () => {
  it("loads model defaults and clears an override explicitly without touching other fields", async () => {
    const config = {
      defaultModel: "configured-main",
      cheapModel: "configured-cheap",
      release: "v0.2.0",
    };
    const { fetch, calls } = fakeFetch({
      "GET /api/config": config,
      "PATCH /api/bots/bot_1": { bot },
    });
    const api = createApiClient({ fetch });
    expect(await api.getConfig()).toEqual(config);
    expect(await api.updateBot(BOT_ID, { model: null })).toEqual(bot);
    expect(calls[1]?.body).toEqual({ model: null });
  });

  it("reopens a held screen as a screen-proxy ticket through the explicit authenticated endpoint", async () => {
    const result = screenTicket();
    const { fetch, calls } = fakeFetch({
      "POST /api/workspaces/ws_1/takeover/open-screen": result,
    });
    expect(await createApiClient({ fetch }).openTakeoverScreen(WS_ID)).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBeUndefined();
  });

  it("notifies session rejection only for 401, while retaining typed failures", async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const api = createApiClient({ fetch, onUnauthorized });
    await expect(api.getConfig()).rejects.toMatchObject({ status: 503 });
    expect(onUnauthorized).not.toHaveBeenCalled();
    await expect(api.getConfig()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it("relies on the session cookie and sends the CSRF token only on unsafe methods", async () => {
    const seen: Array<{
      method: string;
      authorization: string | null;
      csrf: string | null;
      credentials?: RequestCredentials;
    }> = [];
    let csrf = "first";
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        csrf: headers.get("x-deskmates-csrf"),
        ...(init?.credentials ? { credentials: init.credentials } : {}),
      });
      return new Response(JSON.stringify({ workspaces: [], workspace }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const api = createApiClient({ fetch, csrfToken: () => csrf });
    await api.listWorkspaces();
    await api.createWorkspace({ name: "x" });
    // A password change rotates the token; the next mutation uses the new one.
    csrf = "rotated";
    await api.createWorkspace({ name: "y" });
    expect(seen).toEqual([
      { method: "GET", authorization: null, csrf: null, credentials: "same-origin" },
      { method: "POST", authorization: null, csrf: "first", credentials: "same-origin" },
      { method: "POST", authorization: null, csrf: "rotated", credentials: "same-origin" },
    ]);
    expect(api).not.toHaveProperty("operatorToken");
  });

  it("downloads a workspace file as a Blob and ends the session on 401 (ADR-0014)", async () => {
    const onUnauthorized = vi.fn();
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return seen.length === 1
        ? new Response(new Uint8Array([0, 255]), { status: 200 })
        : new Response(JSON.stringify({ code: "token_rejected", message: "no", details: {} }), {
            status: 401,
          });
    }) as unknown as typeof globalThis.fetch;
    const api = createApiClient({ fetch, onUnauthorized });
    const blob = await api.downloadWorkspaceFile(WS_ID, "/work/a b/x.bin");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
    expect(seen[0]).toEqual({
      url: `/api/workspaces/ws_1/files?path=${encodeURIComponent("/work/a b/x.bin").replace("%20", "+")}`,
      authorization: null,
    });
    await expect(api.downloadWorkspaceFile(WS_ID, "/work/x")).rejects.toMatchObject({
      code: "token_rejected",
      status: 401,
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("keeps the selected tenant on a native streamed file download URL", () => {
    const api = createApiClient({ tenantId: "tenant_2" });
    expect(api.workspaceFileDownloadUrl(WS_ID, "/work/report.pdf")).toBe(
      "/api/workspaces/ws_1/files?path=%2Fwork%2Freport.pdf&tenant=tenant_2",
    );
  });

  it("lists and creates workspaces", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces": { workspaces: [workspace] },
      "POST /api/workspaces": { workspace },
    });
    const api = createApiClient({ fetch });
    expect(await api.listWorkspaces()).toEqual([workspace]);
    expect(
      await api.createWorkspace({ name: "default", egressAllowlist: ["example.com"] }),
    ).toEqual(workspace);
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/api/workspaces",
      body: { name: "default", egressAllowlist: ["example.com"] },
    });
  });

  it("lists bots by workspace and creates one", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/bots?workspaceId=ws_1": { bots: [bot] },
      "GET /api/bots": { bots: [bot] },
      "POST /api/bots": { bot },
    });
    const api = createApiClient({ fetch });
    expect(await api.listBots(WS_ID)).toEqual([bot]);
    expect(await api.listBots()).toEqual([bot]);
    expect(await api.createBot({ name: "ops", role: "operator", workspaceId: WS_ID })).toEqual(bot);
    expect(calls[2]?.body).toEqual({ name: "ops", role: "operator", workspaceId: WS_ID });
  });

  it("lists, creates and reads threads", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/threads?workspaceId=ws_1": { threads: [thread] },
      "POST /api/threads": { thread, members },
      "GET /api/threads/thr_1": { thread, members },
    });
    const api = createApiClient({ fetch });
    expect(await api.listThreads(WS_ID)).toEqual([thread]);
    const created = await api.createThread({ workspaceId: WS_ID, botIds: [BOT_ID], title: "x" });
    expect(created.thread).toEqual(thread);
    expect(calls[1]?.body).toEqual({ workspaceId: WS_ID, botIds: [BOT_ID], title: "x" });
    const got = await api.getThread(THREAD_ID);
    expect(got.members[0]?.name).toBe("ops");
  });

  it("retries a Bot welcome and changes workspace-shared thread pins", async () => {
    const queued = run({ triggerKind: "welcome", status: "queued" });
    const { fetch, calls } = fakeFetch({
      "POST /api/bots/bot_1/welcome": { run: queued, thread },
      "POST /api/threads/thr_1/pin": {
        pin: { workspaceId: WS_ID, threadId: THREAD_ID, position: 1 },
      },
      "DELETE /api/threads/thr_1/pin": { deleted: true },
    });
    const api = createApiClient({ fetch });
    expect(await api.retryBotWelcome(BOT_ID)).toEqual({ run: queued, thread });
    expect(await api.pinThread(THREAD_ID)).toEqual({
      workspaceId: WS_ID,
      threadId: THREAD_ID,
      position: 1,
    });
    await api.unpinThread(THREAD_ID);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/bots/bot_1/welcome",
      "POST /api/threads/thr_1/pin",
      "DELETE /api/threads/thr_1/pin",
    ]);
  });

  it("omits optional fields it was not given", async () => {
    const { fetch, calls } = fakeFetch({ "POST /api/threads": { thread, members } });
    await createApiClient({ fetch }).createThread({ workspaceId: WS_ID, botIds: [BOT_ID] });
    expect(calls[0]?.body).toEqual({ workspaceId: WS_ID, botIds: [BOT_ID] });
  });

  it("lists messages with afterSeq and posts {body}", async () => {
    const human = message(1, "human", "hello");
    const { fetch, calls } = fakeFetch({
      "GET /api/threads/thr_1/messages": { messages: [human] },
      "GET /api/threads/thr_1/messages?afterSeq=3": { messages: [] },
      "POST /api/threads/thr_1/messages": { message: human, runs: [run()] },
    });
    const api = createApiClient({ fetch });
    expect(await api.listMessages(THREAD_ID)).toEqual([human]);
    expect(await api.listMessages(THREAD_ID, 3)).toEqual([]);
    const posted = await api.postMessage(THREAD_ID, "hello");
    expect(posted.runs[0]?.id).toBe(RUN_ID);
    expect(calls[2]).toEqual({
      method: "POST",
      path: "/api/threads/thr_1/messages",
      body: { body: "hello" },
    });
    expect(JSON.stringify(calls[2]?.body)).not.toContain("authorId");
  });

  it("lists runs with filters, reads a run with usage, and lists its events", async () => {
    const r = run({ status: "succeeded" });
    const { fetch } = fakeFetch({
      "GET /api/runs?threadId=thr_1": { runs: [r] },
      "GET /api/runs?botId=bot_1": { runs: [r] },
      "GET /api/runs": { runs: [r] },
      "GET /api/runs/run_1": { run: r, usage: [usage("m", null)] },
      "GET /api/runs/run_1/events": { events: [runEvent(1, "log", {})] },
      "GET /api/runs/run_1/events?afterSeq=1": { events: [] },
    });
    const api = createApiClient({ fetch });
    expect((await api.listRuns({ threadId: THREAD_ID })).runs).toEqual([r]);
    expect((await api.listRuns({ botId: BOT_ID })).runs).toEqual([r]);
    expect((await api.listRuns()).runs).toEqual([r]);
    const got = await api.getRun(RUN_ID);
    expect(got.usage[0]?.costUsd).toBeNull();
    expect((await api.listRunEvents(RUN_ID)).map((e) => e.seq)).toEqual([1]);
    expect(await api.listRunEvents(RUN_ID, 1)).toEqual([]);
  });

  it("lists approvals by status, thread and bot, and reads one", async () => {
    const a = approval();
    const { fetch, calls } = fakeFetch({
      "GET /api/approvals": { approvals: [a] },
      "GET /api/approvals?status=pending&threadId=thr_1": { approvals: [a] },
      "GET /api/approvals?status=decided&botId=bot_1": { approvals: [] },
      "GET /api/approvals/apr_1": { approval: a },
    });
    const api = createApiClient({ fetch });
    expect(await api.listApprovals()).toEqual([a]);
    expect(await api.listApprovals({ status: "pending", threadId: THREAD_ID })).toEqual([a]);
    expect(await api.listApprovals({ status: "decided", botId: BOT_ID })).toEqual([]);
    expect(await api.getApproval(APPROVAL_ID)).toEqual(a);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/approvals",
      "/api/approvals?status=pending&threadId=thr_1",
      "/api/approvals?status=decided&botId=bot_1",
      "/api/approvals/apr_1",
    ]);
  });

  it("posts a decision with the reason and returns the rule an Always created", async () => {
    const decided = approval({
      decision: "allow_always",
      decidedBy: "human:operator",
      decidedAt: "2026-09-21T10:01:00.000Z",
    });
    const rule = approvalRule();
    const { fetch, calls } = fakeFetch({
      "POST /api/approvals/apr_1/decide": { approval: decided, rule },
    });
    const api = createApiClient({ fetch });
    const r = await api.decideApproval(APPROVAL_ID, "allow_always");
    expect(r.approval).toEqual(decided);
    expect(r.rule).toEqual(rule);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/approvals/apr_1/decide",
      body: { decision: "allow_always" },
    });
  });

  it("sends the deny reason and surfaces an invalid transition as ApiError", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /api/approvals/apr_1/decide": (c: RecordedCall) =>
        (c.body as { reason?: string }).reason === "too risky"
          ? { approval: approval({ decision: "deny", reason: "too risky" }) }
          : new Error("already decided"),
    });
    const api = createApiClient({ fetch });
    const ok = await api.decideApproval(APPROVAL_ID, "deny", "too risky");
    expect(ok.approval.decision).toBe("deny");
    expect(calls[0]?.body).toEqual({ decision: "deny", reason: "too risky" });
    const err = await api.decideApproval(APPROVAL_ID, "deny").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
  });

  it("lists a bot's approval rules and deletes one", async () => {
    const rule = approvalRule();
    const { fetch, calls } = fakeFetch({
      "GET /api/bots/bot_1/approval-rules": { rules: [rule], offset: 0, limit: 25, total: 1 },
      "DELETE /api/approval-rules/rul_1": { deleted: true },
    });
    const api = createApiClient({ fetch });
    expect((await api.listApprovalRules(BOT_ID)).rules).toEqual([rule]);
    await api.deleteApprovalRule("rul_1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/bots/bot_1/approval-rules",
      "DELETE /api/approval-rules/rul_1",
    ]);
  });

  it("reads one workspace with its lock and screen state, takes over and hands back", async () => {
    const held = workspaceView({ browserLock: browserLock() });
    const { fetch, calls } = fakeFetch({
      "GET /api/workspaces/ws_1": workspaceView(),
      "POST /api/workspaces/ws_1/takeover": { lock: browserLock() },
      "POST /api/workspaces/ws_1/handback": { released: true },
    });
    const api = createApiClient({ fetch });
    const view = await api.getWorkspace(WS_ID);
    expect(view.workspace).toEqual(workspace);
    expect(view.browserLock).toBeNull();
    expect(view.takeoverScreen).toBe(true);

    const taken = await api.takeOver(WS_ID, "operator");
    expect(taken).toEqual({ lock: held.browserLock });
    await api.handBack(WS_ID);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/workspaces/ws_1",
      "POST /api/workspaces/ws_1/takeover",
      "POST /api/workspaces/ws_1/handback",
    ]);
    expect(calls[1]?.body).toEqual({ authorId: "operator" });
  });

  it("omits authorId from a takeover it was not given", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /api/workspaces/ws_1/takeover": { lock: browserLock() },
    });
    const taken = await createApiClient({ fetch }).takeOver(WS_ID);
    expect(taken.lock).toEqual(browserLock());
    expect(calls[0]?.body).toEqual({});
  });

  it("prefixes paths with baseUrl and encodes ids", async () => {
    const { fetch, calls } = fakeFetch({
      "GET http://gw/api/threads/a%2Fb": { thread, members },
    });
    await createApiClient({ fetch, baseUrl: "http://gw" }).getThread("a/b" as typeof THREAD_ID);
    expect(calls[0]?.path).toBe("http://gw/api/threads/a%2Fb");
  });

  it("turns Gateway error bodies into ApiError with the code and status", async () => {
    const { fetch } = fakeFetch({ "POST /api/bots": new Error("name must match [A-Za-z0-9_-]+") });
    const api = createApiClient({ fetch });
    const err = await api.createBot({ name: "bad name", workspaceId: WS_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("validation");
    expect(err.status).toBe(400);
    expect(err.message).toContain("name must match");

    const missing = await api.getRun("nope" as typeof RUN_ID).catch((e) => e);
    expect(missing.code).toBe("not_found");
    expect(missing.status).toBe(404);
  });

  it("reports a failed fetch as a network error", async () => {
    const failing = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const err = await createApiClient({ fetch: failing })
      .listWorkspaces()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network");
    expect(err.status).toBe(0);
  });
});
