// #113 slice K1: Knowledge documents, search and proposals page on the server with honest totals.
// No silent truncation: every document, match and pending proposal is reachable, a limit above
// the maximum is refused, and a cursor of another list or filter is refused.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const human = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
let sandbox: ReturnType<typeof buildGateway>;
let operator: ReturnType<typeof buildOperatorGateway>;

beforeEach(async () => {
  sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
});
afterEach(async () => {
  await operator.close();
  await sandbox.close();
});

/** 60 published documents sharing one timestamp (the id breaks the tie), all matching "alpha". */
function seed(): void {
  const db = sandbox.deskmates.ctx.db;
  const doc = db.prepare(
    "INSERT INTO knowledge_docs(id,tenant_id,path,title,body,approved_by,updated_at,version) VALUES (?,?,?,?,?,?,?,1)",
  );
  const proposal = db.prepare(
    "INSERT INTO knowledge_proposals(id,tenant_id,title,body,status,created_at) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < 60; i += 1) {
    const n = String(i).padStart(2, "0");
    doc.run(
      `kb_${n}`,
      DEFAULT_TENANT_ID,
      `p${n}`,
      `Doc ${n}`,
      "alpha",
      "human:web",
      "2026-10-13T00:00:00.000Z",
    );
    proposal.run(
      `kp_${n}`,
      DEFAULT_TENANT_ID,
      `P ${n}`,
      "body",
      "pending",
      "2026-10-13T00:00:00.000Z",
    );
  }
  proposal.run(
    "kp_done",
    DEFAULT_TENANT_ID,
    "Done",
    "body",
    "approved",
    "2026-10-12T00:00:00.000Z",
  );
}

async function get(url: string) {
  return operator.inject({ method: "GET", url, headers: human });
}

async function walk(path: string, key: string): Promise<{ ids: string[]; totals: number[] }> {
  const ids: string[] = [];
  const totals: number[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const response = await get(`${path}${sep}limit=25${cursor ? `&cursor=${cursor}` : ""}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    ids.push(...body[key].map((item: { id: string }) => item.id));
    totals.push(body.total);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return { ids, totals };
}

describe("Knowledge pagination (#113 K1)", () => {
  it("reaches every published document across three pages, newest then id descending", async () => {
    seed();
    const { ids, totals } = await walk("/api/knowledge", "documents");
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids[0]).toBe("kb_59");
    expect(ids.at(-1)).toBe("kb_00");
    expect(totals).toEqual([60, 60, 60]);
  });

  it("reaches every pending proposal and counts the whole queue", async () => {
    seed();
    const { ids, totals } = await walk("/api/knowledge/proposals?status=pending", "proposals");
    expect(ids).toHaveLength(60);
    expect(ids).not.toContain("kp_done");
    expect(totals[0]).toBe(60);
  });

  it("pages search over the rank with the honest number of matches", async () => {
    seed();
    const first = (await get("/api/knowledge?q=alpha&limit=25")).json();
    expect(first).toMatchObject({ offset: 0, limit: 25, total: 60 });
    expect(first.documents).toHaveLength(25);
    const last = (await get("/api/knowledge?q=alpha&offset=50&limit=25")).json();
    expect(last.documents).toHaveLength(10);
    const beyond = (await get("/api/knowledge?q=alpha&offset=75&limit=25")).json();
    expect(beyond).toMatchObject({ documents: [], total: 60 });
    const all = [
      first,
      (await get("/api/knowledge?q=alpha&offset=25&limit=25")).json(),
      last,
    ].flatMap((page) => page.documents.map((d: { id: string }) => d.id));
    expect(new Set(all).size).toBe(60);
  });

  it("refuses a limit above the maximum instead of clamping it", async () => {
    seed();
    for (const url of [
      "/api/knowledge?limit=101",
      "/api/knowledge?q=alpha&limit=500",
      "/api/knowledge/proposals?limit=101",
      "/api/knowledge/kb_00/history?limit=101",
      "/api/knowledge?limit=0",
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json().code, url).toBe("validation");
    }
  });

  it("refuses a cursor from another list or another status filter", async () => {
    seed();
    const docs = (await get("/api/knowledge?limit=25")).json();
    const pending = (await get("/api/knowledge/proposals?status=pending&limit=25")).json();
    expect((await get(`/api/knowledge/proposals?cursor=${docs.nextCursor}`)).statusCode).toBe(400);
    expect(
      (await get(`/api/knowledge/proposals?status=approved&cursor=${pending.nextCursor}`))
        .statusCode,
    ).toBe(400);
    expect((await get("/api/knowledge?cursor=garbage")).statusCode).toBe(400);
  });

  it("answers an empty list with no cursor and a zero total", async () => {
    const body = (await get("/api/knowledge")).json();
    expect(body).toEqual({ documents: [], total: 0 });
    expect((await get("/api/knowledge/proposals")).json()).toEqual({ proposals: [], total: 0 });
  });
});
