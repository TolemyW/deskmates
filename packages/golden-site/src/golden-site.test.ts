// T1: start the console on an ephemeral port and drive it with fetch, the way a run would through
// the browser. No Docker, no model, no network beyond loopback.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MFA_ACCOUNT, MFA_CODE, OPS_ACCOUNT, PASSWORD } from "./seed.js";
import { type GoldenSite, SESSION_COOKIE, startGoldenSite } from "./server.js";
import type { OpLogEntry, StateView } from "./state.js";

let site: GoldenSite;

beforeAll(async () => {
  site = await startGoldenSite({ port: 0 });
});

afterAll(async () => {
  await site.close();
});

beforeEach(async () => {
  const r = await fetch(`${site.url}/api/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
  expect(r.status).toBe(200);
});

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

function cookieFrom(r: Response): string {
  const raw = r.headers.get("set-cookie") ?? "";
  const m = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  expect(m?.[1], `expected a ${SESSION_COOKIE} cookie`).toBeTruthy();
  return `${SESSION_COOKIE}=${m?.[1]}`;
}

async function login(email: string, password = PASSWORD): Promise<{ r: Response; cookie: string }> {
  const r = await fetch(`${site.url}/login`, form({ email, password }));
  return { r, cookie: cookieFrom(r) };
}

async function state(): Promise<StateView> {
  return (await (await fetch(`${site.url}/api/state`)).json()) as StateView;
}

describe("golden site: login", () => {
  it("serves the login form and rejects a wrong password with a stable message", async () => {
    const get = await fetch(`${site.url}/login`);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('id="login-form"');

    const bad = await fetch(`${site.url}/login`, form({ email: OPS_ACCOUNT, password: "nope" }));
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Invalid email or password.");
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect((await state()).session.logged_in).toBe(false);
  });

  it("logs the no-MFA account in, sets a cookie, and lets it reach the dashboard", async () => {
    const { r, cookie } = await login(OPS_ACCOUNT);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/dashboard");

    const dash = await fetch(`${site.url}/dashboard`, { headers: { cookie } });
    expect(dash.status).toBe(200);
    const html = await dash.text();
    expect(html).toContain(`Signed in as ${OPS_ACCOUNT}`);
    expect(html).toContain('id="open-ticket-count"');
    const s = await state();
    expect(s.session).toMatchObject({ logged_in: true, user: OPS_ACCOUNT, mfa_passed: true });
  });

  it("redirects an anonymous request for a protected page to /login", async () => {
    const r = await fetch(`${site.url}/dashboard`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login?next=%2Fdashboard");
  });
});

describe("golden site: MFA", () => {
  it("parks the MFA account at /mfa until the fixed code is entered", async () => {
    const { r, cookie } = await login(MFA_ACCOUNT);
    expect(r.headers.get("location")).toBe("/mfa");

    const blocked = await fetch(`${site.url}/dashboard`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(blocked.status).toBe(302);
    expect(blocked.headers.get("location")).toBe("/mfa");
    expect((await state()).session).toMatchObject({ mfa_required: true, mfa_passed: false });

    const wrong = await fetch(`${site.url}/mfa`, {
      ...form({ code: "000000" }),
      headers: { ...form({}).headers, cookie },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${site.url}/mfa`, {
      ...form({ code: MFA_CODE }),
      headers: { ...form({}).headers, cookie },
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/dashboard");
    expect((await state()).session.mfa_passed).toBe(true);

    const dash = await fetch(`${site.url}/dashboard`, { headers: { cookie } });
    expect(dash.status).toBe(200);
  });
});

describe("golden site: vision-only fixtures", () => {
  it("keeps Approve in a closed shadow root and records one authenticated approval", async () => {
    const anonymous = await fetch(`${site.url}/shadow`, { redirect: "manual" });
    expect(anonymous.status).toBe(302);
    const { cookie } = await login(OPS_ACCOUNT);
    const page = await fetch(`${site.url}/shadow`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("attachShadow({mode:'closed'})");
    expect(html).not.toMatch(/<button[^>]*>Approve<\/button>/);
    expect((await state()).shadow.approved).toBe(false);

    const denied = await fetch(`${site.url}/shadow/approve`, {
      method: "POST",
      redirect: "manual",
    });
    expect(denied.status).toBe(302);
    expect((await state()).shadow.approved).toBe(false);
    for (let i = 0; i < 2; i++) {
      const approved = await fetch(`${site.url}/shadow/approve`, {
        method: "POST",
        headers: { cookie },
      });
      expect(approved.status).toBe(200);
    }
    expect((await state()).shadow.approved).toBe(true);
    expect(site.state.opLog().filter((entry) => entry.op === "shadow_approve")).toHaveLength(1);
    site.state.reset();
    expect((await state()).shadow.approved).toBe(false);
  });

  it("paints the chart value and Refresh control in pixels and advances only on a click POST", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const page = await fetch(`${site.url}/canvas`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<canvas id="operations-chart"');
    expect(html).toContain("ctx.fillText('Refresh'");
    expect(html).not.toMatch(/<button[^>]*>Refresh<\/button>/);
    expect((await state()).canvas.number).toBe(41);
    const denied = await fetch(`${site.url}/canvas/value`, {
      method: "POST",
      redirect: "manual",
    });
    expect(denied.status).toBe(302);
    const initial = await fetch(`${site.url}/canvas/value`, { headers: { cookie } });
    expect(await initial.json()).toEqual({ number: 41 });
    const refreshed = await fetch(`${site.url}/canvas/value`, {
      method: "POST",
      headers: { cookie },
    });
    expect(await refreshed.json()).toEqual({ number: 42 });
    expect((await state()).canvas.number).toBe(42);
    expect(site.state.opLog().filter((entry) => entry.op === "canvas_refresh")).toHaveLength(1);
    site.state.reset();
    expect((await state()).canvas.number).toBe(41);
  });
});

describe("golden site: checkout and state", () => {
  it("starts from the seed: 50 orders, O-2050 latest, O-2031 paid, August totals 128330.00", async () => {
    const s = await state();
    expect(Object.keys(s.tickets)).toHaveLength(80);
    expect(Object.values(s.tickets).filter((ticket) => ticket.status === "open")).toHaveLength(23);
    expect(Object.values(s.tickets).filter((ticket) => ticket.tags.includes("bug"))).toHaveLength(
      14,
    );
    expect(
      Object.values(s.tickets).filter(
        (ticket) => ticket.status === "open" && ticket.tags.includes("vip"),
      ),
    ).toHaveLength(5);
    expect(
      Object.values(s.tickets)
        .filter((ticket) => ticket.status === "open" && ticket.assignee === "zhang")
        .map((ticket) => ticket.id),
    ).toEqual(["1012", "1024", "1036"]);
    // X03's reassign-to-li arm must perform a real write instead of accepting the seed unchanged.
    expect(s.tickets["1050"]?.assignee).toBe("wang");
    expect(Object.keys(s.orders)).toHaveLength(50);
    expect(s.orders["O-2031"]?.status).toBe("paid");
    const august = Object.values(s.orders).filter((o) => o.createdAt.startsWith("2026-08"));
    expect(august.reduce((sum, o) => sum + o.amount, 0)).toBe(128330);
    expect(s.customers["C-0002"]).toMatchObject({ name: "Acme Corp", email: "acme@old.test" });
    expect(s.customers["C-0021"]?.phone).toBe("13900000021");
    const latest = await (await fetch(`${site.url}/api/state/orders.O-2050.id`)).json();
    expect(latest).toBe("O-2050");
  });

  it("submits the checkout form, creates order 51, and records it in the op log", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const page = await fetch(`${site.url}/checkout`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="submit-order"');

    const post = await fetch(`${site.url}/checkout`, {
      ...form({ customerId: "C-0002", sku: "SKU-7", quantity: "1" }),
      headers: { ...form({}).headers, cookie },
    });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("/checkout?placed=O-2051");

    const confirm = await fetch(`${site.url}/checkout?placed=O-2051`, { headers: { cookie } });
    expect(await confirm.text()).toContain('id="order-id">O-2051<');

    const s = await state();
    expect(Object.keys(s.orders)).toHaveLength(51);
    expect(s.orders["O-2051"]).toMatchObject({
      customerId: "C-0002",
      sku: "SKU-7",
      quantity: 1,
      amount: 350,
    });

    const log = (await (await fetch(`${site.url}/api/state/log`)).json()) as OpLogEntry[];
    const ops = log.map((e) => e.op);
    expect(ops.indexOf("login")).toBeLessThan(ops.indexOf("order_placed"));
    expect(log.at(-1)?.details).toMatchObject({ id: "O-2051", customer: "C-0002" });
  });

  it("rejects a checkout with an unknown customer and does not create an order", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const post = await fetch(`${site.url}/checkout`, {
      ...form({ customerId: "C-9999", sku: "SKU-1", quantity: "1" }),
      headers: { ...form({}).headers, cookie },
    });
    expect(post.status).toBe(400);
    expect(await post.text()).toContain("Unknown customer C-9999");
    expect(Object.keys((await state()).orders)).toHaveLength(50);
  });

  it("requires a session for checkout", async () => {
    const r = await fetch(
      `${site.url}/checkout`,
      form({ customerId: "C-0002", sku: "SKU-1", quantity: "1" }),
    );
    expect(r.status).toBe(302);
    expect(Object.keys((await state()).orders)).toHaveLength(50);
  });

  it("resets to the seed via POST /api/state/reset and drops sessions", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    await fetch(`${site.url}/checkout`, {
      ...form({ customerId: "C-0007", sku: "SKU-2", quantity: "3" }),
      headers: { ...form({}).headers, cookie },
    });
    expect(Object.keys((await state()).orders)).toHaveLength(51);

    const r = await fetch(`${site.url}/api/state/reset`, { method: "POST" });
    expect(r.status).toBe(200);
    const s = await state();
    expect(Object.keys(s.orders)).toHaveLength(50);
    expect(s.session.logged_in).toBe(false);
    const dash = await fetch(`${site.url}/dashboard`, { headers: { cookie }, redirect: "manual" });
    expect(dash.status).toBe(302);
  });

  it("answers 404 with a TODO marker for modules that remain out of scope", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const r = await fetch(`${site.url}/customers`, { headers: { cookie } });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("TODO(M1)");
  });

  it("leaves checkout alone while the human verification option is off (the default)", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const post = await fetch(`${site.url}/checkout`, {
      ...form({ customerId: "C-0002", sku: "SKU-7", quantity: "1" }),
      headers: { ...form({}).headers, cookie },
    });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("/checkout?placed=O-2051");
    const s = await state();
    expect(s.humanCheck.enabled).toBe(false);
    expect(s.humanCheck.verifiedSessions).toBe(0);
    // With the step off, `/verify` has nothing to ask about and sends the session back.
    const v = await fetch(`${site.url}/verify`, { headers: { cookie }, redirect: "manual" });
    expect(v.status).toBe(302);
    expect(v.headers.get("location")).toBe("/checkout");
  });
});

describe("golden site: tickets and reports", () => {
  it("shows the canonical dashboard metrics and report totals", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const dashboard = await fetch(`${site.url}/dashboard`, { headers: { cookie } });
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('id="open-ticket-count">23<');
    expect(dashboardHtml).toContain('id="month-revenue">128450.00<');

    const reports = await fetch(`${site.url}/reports`, { headers: { cookie } });
    const reportHtml = await reports.text();
    expect(reports.status).toBe(200);
    expect(reportHtml).toContain('data-report-month="2026-08"');
    expect(reportHtml).toContain("128450.00");

    const csv = await fetch(`${site.url}/reports/export?month=2026-08`, {
      headers: { cookie },
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).trim().split("\n")[2]).toBe("2026-08-02,Adjustments,4120.50");
  });

  it("filters tickets by status, assignee, label, and comment text", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const zhang = await fetch(`${site.url}/tickets?status=open&assignee=zhang`, {
      headers: { cookie },
    });
    const zhangHtml = await zhang.text();
    expect(zhangHtml).toContain('id="ticket-result-count">3 tickets<');
    for (const id of ["1012", "1024", "1036"]) {
      expect(zhangHtml).toContain(`href="/tickets/${id}"`);
    }
    expect(zhangHtml).not.toContain('href="/tickets/1007"');

    const refund = await fetch(`${site.url}/tickets?q=refund`, { headers: { cookie } });
    const refundHtml = await refund.text();
    expect(refundHtml).toContain('id="ticket-result-count">2 tickets<');
    expect(refundHtml).toContain('href="/tickets/1015"');
    expect(refundHtml).toContain('href="/tickets/1058"');

    const vip = await fetch(`${site.url}/tickets?status=open&label=vip`, {
      headers: { cookie },
    });
    expect(await vip.text()).toContain('id="ticket-result-count">5 tickets<');

    const zhangState = (await (
      await fetch(`${site.url}/api/state/tickets.where.assignee=zhang,status=open`)
    ).json()) as StateView["tickets"][string][];
    expect(zhangState.map((ticket) => ticket.id)).toEqual(["1012", "1024", "1036"]);
    const refundState = (await (
      await fetch(`${site.url}/api/state/tickets.where.comments~refund`)
    ).json()) as StateView["tickets"][string][];
    expect(refundState.map((ticket) => ticket.id)).toEqual(["1015", "1058"]);
    const overdueState = (await (
      await fetch(`${site.url}/api/state/tickets.where.tags~bug,status=open,created_at>30d`)
    ).json()) as StateView["tickets"][string][];
    expect(overdueState.map((ticket) => ticket.id)).toEqual([
      "1003",
      "1011",
      "1019",
      "1027",
      "1035",
      "1043",
    ]);
  });

  it("supports comment, reassign, label, and close forms with ordered operation logs", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const detail = await fetch(`${site.url}/tickets/1050`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain('id="comment-form"');
    expect(detailHtml).toContain('id="reassign-form"');
    expect(detailHtml).toContain(
      `id="ticket-created-at">${site.state.data.tickets["1050"]?.created_at}<`,
    );

    const actions = [
      ["comment", { comment: "Fix confirmed" }],
      ["reassign", { assignee: "li" }],
      ["label", { label: "urgent" }],
      ["close", {}],
    ] as const;
    for (const [action, fields] of actions) {
      const response = await fetch(`${site.url}/tickets/1050/${action}`, {
        ...form(fields),
        headers: { ...form({}).headers, cookie },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/tickets/1050");
    }

    const ticket = (await state()).tickets["1050"];
    expect(ticket).toMatchObject({ status: "closed", assignee: "li" });
    expect(ticket?.comments).toContain("Fix confirmed");
    expect(ticket?.tags).toContain("urgent");
    const log = (await (await fetch(`${site.url}/api/state/log`)).json()) as OpLogEntry[];
    const comment = log.find((entry) => entry.op === "ticket_comment");
    const close = log.find((entry) => entry.op === "ticket_close");
    expect(comment?.details).toMatchObject({ id: "1050", comment: "Fix confirmed" });
    expect(comment?.seq).toBeLessThan(close?.seq ?? 0);
  });

  it("keeps a concurrent comment and reassignment on ticket 1050 without a lost update", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const headers = { ...form({}).headers, cookie, accept: "application/json" };
    const [comment, reassign] = await Promise.all([
      fetch(`${site.url}/tickets/1050/comment`, {
        ...form({ comment: "Concurrent note" }),
        headers,
      }),
      fetch(`${site.url}/tickets/1050/reassign`, {
        ...form({ assignee: "li" }),
        headers,
      }),
    ]);
    expect(comment.status).toBe(200);
    expect(reassign.status).toBe(200);
    const ticket = (await state()).tickets["1050"];
    expect(ticket?.comments).toContain("Concurrent note");
    expect(ticket?.assignee).toBe("li");
  });

  it("supports the exact M02 and M07 mutation flows without changing neighbouring tickets", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const before = await state();
    for (const id of ["1012", "1024", "1036"]) {
      const response = await fetch(`${site.url}/tickets/${id}/reassign`, {
        ...form({ assignee: "li" }),
        headers: { ...form({}).headers, cookie },
      });
      expect(response.status).toBe(302);
    }
    for (const id of ["1015", "1058"]) {
      const response = await fetch(`${site.url}/tickets/${id}/label`, {
        ...form({ label: "refund" }),
        headers: { ...form({}).headers, cookie },
      });
      expect(response.status).toBe(302);
    }
    const after = await state();
    expect(
      Object.values(after.tickets).filter(
        (ticket) => ticket.status === "open" && ticket.assignee === "zhang",
      ),
    ).toHaveLength(0);
    expect(after.tickets["1015"]?.tags).toContain("refund");
    expect(after.tickets["1058"]?.tags).toContain("refund");
    expect(
      Object.values(after.tickets).filter((ticket) => ticket.tags.includes("refund")),
    ).toHaveLength(2);
    expect(after.tickets["1007"]).toEqual(before.tickets["1007"]);
  });

  it("rejects invalid ticket changes without mutating state", async () => {
    const { cookie } = await login(OPS_ACCOUNT);
    const before = structuredClone((await state()).tickets["1050"]);
    const response = await fetch(`${site.url}/tickets/1050/reassign`, {
      ...form({ assignee: "nobody" }),
      headers: { ...form({}).headers, cookie, accept: "application/json" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Assignee must be li, wang, or zhang" });
    expect((await state()).tickets["1050"]).toEqual(before);
  });
});

// The human verification step is a step a bot must not solve by itself: the code exists only as a
// picture, so getting past it needs a person at the screen (acceptance/m1-takeover). These cases
// run against a second server started with the option on; the one above keeps the default.
describe("golden site: human verification", () => {
  let checked: GoldenSite;

  beforeAll(async () => {
    checked = await startGoldenSite({ port: 0, humanCheck: true });
  });

  afterAll(async () => {
    await checked.close();
  });

  beforeEach(async () => {
    await fetch(`${checked.url}/api/state/reset`, { method: "POST" });
  });

  async function checkedState(): Promise<StateView> {
    return (await (await fetch(`${checked.url}/api/state`)).json()) as StateView;
  }

  async function checkedLogin(): Promise<string> {
    const r = await fetch(`${checked.url}/login`, form({ email: OPS_ACCOUNT, password: PASSWORD }));
    const raw = r.headers.get("set-cookie") ?? "";
    const m = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
    return `${SESSION_COOKIE}=${m?.[1]}`;
  }

  function submitOrder(cookie: string): Promise<Response> {
    return fetch(`${checked.url}/checkout`, {
      ...form({ customerId: "C-0002", sku: "SKU-7", quantity: "1" }),
      headers: { ...form({}).headers, cookie },
    });
  }

  it("holds the first checkout at /verify and shows the code only as a picture", async () => {
    const cookie = await checkedLogin();
    const post = await submitOrder(cookie);
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("/verify");
    // Held, not placed.
    expect(Object.keys((await checkedState()).orders)).toHaveLength(50);

    const pageRes = await fetch(`${checked.url}/verify`, { headers: { cookie } });
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain('id="verify-form"');
    expect(html).toContain('id="verify-image"');
    // The whole point: no plain-text copy anywhere in the markup, and nothing in the
    // accessibility tree either — the glyphs sit inside an aria-hidden svg, out of reading order.
    const code = (await checkedState()).humanCheck.code;
    expect(code).toHaveLength(6);
    expect(html).not.toContain(code);
    expect(html).toContain('aria-hidden="true"');
  });

  it("re-renders with an error and a new code on a wrong answer, and places nothing", async () => {
    const cookie = await checkedLogin();
    await submitOrder(cookie);
    const before = (await checkedState()).humanCheck.code;

    const wrong = await fetch(`${checked.url}/verify`, {
      ...form({ code: "ZZZZZZ" }),
      headers: { ...form({}).headers, cookie },
    });
    expect(wrong.status).toBe(400);
    const html = await wrong.text();
    expect(html).toContain("That code does not match the picture.");
    expect(html).toContain('id="verify-form"');

    const after = await checkedState();
    expect(Object.keys(after.orders)).toHaveLength(50);
    expect(after.humanCheck.verifiedSessions).toBe(0);
    expect(after.humanCheck.code).not.toBe(before);
    expect(html).not.toContain(after.humanCheck.code);
  });

  it("places the held order on the right code and asks no second time in that session", async () => {
    const cookie = await checkedLogin();
    await submitOrder(cookie);
    const code = (await checkedState()).humanCheck.code;

    const ok = await fetch(`${checked.url}/verify`, {
      ...form({ code }),
      headers: { ...form({}).headers, cookie },
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/checkout?placed=O-2051");

    const after = await checkedState();
    expect(Object.keys(after.orders)).toHaveLength(51);
    expect(after.orders["O-2051"]).toMatchObject({
      customerId: "C-0002",
      sku: "SKU-7",
      quantity: 1,
      amount: 350,
    });
    expect(after.humanCheck.verifiedSessions).toBe(1);

    const log = (await (await fetch(`${checked.url}/api/state/log`)).json()) as OpLogEntry[];
    const verifyOps = log.filter((e) => e.op === "verify").map((e) => e.details.phase);
    expect(verifyOps).toEqual(["required", "passed"]);

    // A verified session checks out straight through.
    const second = await fetch(`${checked.url}/checkout`, {
      ...form({ customerId: "C-0003", sku: "SKU-2", quantity: "1" }),
      headers: { ...form({}).headers, cookie },
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe("/checkout?placed=O-2052");
    expect(Object.keys((await checkedState()).orders)).toHaveLength(52);
  });
});
