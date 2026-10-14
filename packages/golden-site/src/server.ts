// The Galaxy Ops Console as a plain node:http server (test strategy §3.3, benchmark §2).
// Implemented pages: auth, dashboard, checkout, tickets, reports and the test state API.
// Other benchmark modules answer 404 with a TODO marker; see IMPLEMENTATION.md in this directory.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { canvasPage } from "./canvas-page.js";
import { errorBox, escapeHtml, page } from "./html.js";
import { SKUS, type Ticket } from "./seed.js";
import { shadowPage } from "./shadow-page.js";
import { GoldenSiteState, type Session } from "./state.js";

export const SESSION_COOKIE = "gsid";

export interface GoldenSiteOptions {
  /** 0 (default) picks an ephemeral port. */
  port?: number;
  host?: string;
  /** Supply a state to share it between a server and a test; a fresh one is created otherwise. */
  state?: GoldenSiteState;
  /**
   * Put the human verification step (`/verify`) in front of a session's first checkout. Off by
   * default, so every other suite sees the console it has always seen. Ignored when `state` is
   * given: the state carries the flag (`GoldenSiteStateOptions.humanCheck`).
   */
  humanCheck?: boolean;
}

export interface GoldenSite {
  url: string;
  port: number;
  state: GoldenSiteState;
  server: Server;
  close(): Promise<void>;
}

/** Implemented top-level routes, used only to make the final 404 useful while debugging. */
const M0_ROUTES = [
  "/",
  "/login",
  "/mfa",
  "/dashboard",
  "/verify",
  "/checkout",
  "/orders/new",
  "/tickets",
  "/reports",
  "/logout",
  "/api/state",
  "/shadow",
  "/canvas",
];

const STUB_ROUTES = [
  "/tickets/new",
  "/customers",
  "/orders",
  "/reports/flaky",
  "/import",
  "/wizard",
  "/settings",
  "/session-only",
];

export async function startGoldenSite(options: GoldenSiteOptions = {}): Promise<GoldenSite> {
  const state = options.state ?? new GoldenSiteState({ humanCheck: options.humanCheck ?? false });
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    handle(state, req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendText(res, 500, `golden-site error: ${msg}`);
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    state,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ---- request plumbing ----------------------------------------------------------------------

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendCsv(res: ServerResponse, filename: string, body: string): void {
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  res.end(body);
}

function redirect(
  res: ServerResponse,
  location: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(302, { location, ...extraHeaders });
  res.end();
}

function sessionCookie(session: Session | undefined): string {
  return session
    ? `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax`
    : `${SESSION_COOKIE}=; Path=/; Max-Age=0`;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Accepts form-urlencoded (browser) and JSON (fetch in tests); returns string fields. */
async function readFields(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req);
  const type = req.headers["content-type"] ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) out[k] = typeof v === "string" ? v : String(v);
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function wantsJson(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("application/json");
}

// ---- routing -------------------------------------------------------------------------------

async function handle(
  state: GoldenSiteState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://golden.test");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";
  const session = state.session(cookieValue(req, SESSION_COOKIE));

  if (path === "/api/state" || path.startsWith("/api/state/"))
    return apiState(state, req, res, path, method);
  if (path === "/") return redirect(res, session ? "/dashboard" : "/login");
  if (path === "/login") return login(state, req, res, method, url);
  if (path === "/mfa") return mfa(state, req, res, method, session);
  if (path === "/logout") return logout(state, res, method, session);

  // Everything below needs an authenticated (past-MFA) session.
  const auth = state.authenticated(session?.id);
  if (!auth) {
    if (session?.needsMfa && !session.mfaPassed) return redirect(res, "/mfa");
    return redirect(res, `/login?next=${encodeURIComponent(path)}`);
  }
  if (path === "/dashboard") return dashboard(state, res, auth);
  if (path === "/verify") return verify(state, req, res, method, auth);
  if (path === "/checkout" || path === "/orders/new")
    return checkout(state, req, res, method, auth, url);
  if (path === "/tickets") return tickets(state, res, method, auth, url);
  const ticketPath = path.match(/^\/tickets\/(\d+)(?:\/(comment|reassign|label|close))?$/);
  if (ticketPath) {
    return ticketDetail(state, req, res, method, auth, ticketPath[1] ?? "", ticketPath[2]);
  }
  if (path === "/reports") return reports(state, res, method, auth);
  if (path === "/reports/export") return reportExport(state, res, method, url);
  if (path === "/shadow") {
    if (method !== "GET") return sendText(res, 405, "Method not allowed");
    return sendHtml(res, 200, shadowPage(auth.email, state.shadowApproved));
  }
  if (path === "/shadow/approve") {
    if (method !== "POST") return sendText(res, 405, "Method not allowed");
    state.approveShadow();
    return sendJson(res, 200, { approved: state.shadowApproved });
  }
  if (path === "/canvas") {
    if (method !== "GET") return sendText(res, 405, "Method not allowed");
    return sendHtml(res, 200, canvasPage(auth.email));
  }
  if (path === "/canvas/value") {
    if (method === "POST") return sendJson(res, 200, { number: state.refreshCanvas() });
    if (method === "GET") return sendJson(res, 200, { number: state.canvasNumber });
    return sendText(res, 405, "Method not allowed");
  }
  if (STUB_ROUTES.includes(path) || path.startsWith("/customers/") || path.startsWith("/orders/")) {
    return sendText(
      res,
      404,
      `TODO(M1): ${path} is not part of the M0 golden site. See src/golden-site/README.md.`,
    );
  }
  return sendText(res, 404, `Not found: ${path}. M0 routes: ${M0_ROUTES.join(", ")}`);
}

// ---- /tickets ------------------------------------------------------------------------------

function selected(actual: string, value: string): string {
  return actual === value ? " selected" : "";
}

function tickets(
  state: GoldenSiteState,
  res: ServerResponse,
  method: string,
  session: Session,
  url: URL,
): void {
  if (method !== "GET") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  const status = url.searchParams.get("status")?.trim().toLowerCase() ?? "";
  const label = url.searchParams.get("label")?.trim().toLowerCase() ?? "";
  const assignee = url.searchParams.get("assignee")?.trim().toLowerCase() ?? "";
  const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const matches = Object.values(state.data.tickets).filter(
    (ticket) =>
      (!status || ticket.status === status) &&
      (!label || ticket.tags.includes(label)) &&
      (!assignee || ticket.assignee === assignee) &&
      (!q ||
        ticket.id.includes(q) ||
        ticket.title.toLowerCase().includes(q) ||
        ticket.comments.some((comment) => comment.toLowerCase().includes(q))),
  );
  const rows = matches
    .map(
      (ticket) => `<tr data-ticket-id="${ticket.id}">
  <td><a href="/tickets/${ticket.id}">${ticket.id}</a></td>
  <td>${escapeHtml(ticket.title)}</td>
  <td>${ticket.status}</td>
  <td>${escapeHtml(ticket.assignee)}</td>
  <td>${escapeHtml(ticket.tags.join(", "))}</td>
</tr>`,
    )
    .join("\n");
  sendHtml(
    res,
    200,
    page({
      title: "Tickets",
      user: session.email,
      body: `<h2 id="page-title">Tickets</h2>
<form id="ticket-filters" method="get" action="/tickets">
  <label>Status <select id="filter-status" name="status">
    <option value="">Any</option><option value="open"${selected(status, "open")}>Open</option><option value="closed"${selected(status, "closed")}>Closed</option>
  </select></label>
  <label>Label <input id="filter-label" name="label" value="${escapeHtml(label)}"></label>
  <label>Assignee <select id="filter-assignee" name="assignee">
    <option value="">Any</option><option value="li"${selected(assignee, "li")}>li</option><option value="wang"${selected(assignee, "wang")}>wang</option><option value="zhang"${selected(assignee, "zhang")}>zhang</option>
  </select></label>
  <label>Search title or comments <input id="filter-query" name="q" value="${escapeHtml(q)}"></label>
  <button id="apply-ticket-filters" type="submit">Apply filters</button>
</form>
<p id="ticket-result-count">${matches.length} tickets</p>
<table id="ticket-list"><thead><tr><th>Id</th><th>Title</th><th>Status</th><th>Assignee</th><th>Labels</th></tr></thead><tbody>${rows}</tbody></table>`,
    }),
  );
}

function ticketPage(ticket: Ticket, session: Session, notice?: string, error?: string): string {
  const comments = ticket.comments.length
    ? `<ol id="ticket-comments">${ticket.comments.map((comment) => `<li>${escapeHtml(comment)}</li>`).join("")}</ol>`
    : '<p id="ticket-comments-empty">No comments.</p>';
  return page({
    title: `Ticket ${ticket.id}`,
    user: session.email,
    body: `<h2 id="page-title">Ticket <span id="ticket-id">${ticket.id}</span>: <span id="ticket-title">${escapeHtml(ticket.title)}</span></h2>
${notice ? `<p class="notice" id="ticket-notice">${escapeHtml(notice)}</p>` : ""}
${errorBox(error)}
<dl id="ticket-fields">
  <dt>Status</dt><dd id="ticket-status">${ticket.status}</dd>
  <dt>Assignee</dt><dd id="ticket-assignee">${escapeHtml(ticket.assignee)}</dd>
  <dt>Labels</dt><dd id="ticket-labels">${escapeHtml(ticket.tags.join(", "))}</dd>
  <dt>Customer</dt><dd id="ticket-customer">${escapeHtml(ticket.customer)}</dd>
  <dt>Created</dt><dd id="ticket-created-at">${escapeHtml(ticket.created_at)}</dd>
</dl>
<p id="ticket-description">${escapeHtml(ticket.description)}</p>
<section><h3>Comments</h3>${comments}</section>
<form id="comment-form" method="post" action="/tickets/${ticket.id}/comment">
  <label>Comment <textarea id="comment" name="comment" maxlength="2000" required></textarea></label>
  <button id="add-comment" type="submit">Add comment</button>
</form>
<form id="reassign-form" method="post" action="/tickets/${ticket.id}/reassign">
  <label>Assignee <select id="assignee" name="assignee">
    <option value="li"${selected(ticket.assignee, "li")}>li</option><option value="wang"${selected(ticket.assignee, "wang")}>wang</option><option value="zhang"${selected(ticket.assignee, "zhang")}>zhang</option>
  </select></label>
  <button id="reassign-ticket" type="submit">Reassign</button>
</form>
<form id="label-form" method="post" action="/tickets/${ticket.id}/label">
  <label>Label <input id="label" name="label" required></label>
  <button id="add-label" type="submit">Add label</button>
</form>
<form id="close-form" method="post" action="/tickets/${ticket.id}/close">
  <button id="close-ticket" type="submit"${ticket.status === "closed" ? " disabled" : ""}>Close ticket</button>
</form>`,
  });
}

async function ticketDetail(
  state: GoldenSiteState,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  session: Session,
  id: string,
  action: string | undefined,
): Promise<void> {
  const ticket = state.ticket(id);
  if (!ticket) return sendText(res, 404, `Unknown ticket ${id}`);
  if (method === "GET" && action === undefined)
    return sendHtml(res, 200, ticketPage(ticket, session));
  if (method !== "POST" || action === undefined) return sendText(res, 405, "Method not allowed");
  const fields = await readFields(req);
  const result =
    action === "comment"
      ? state.commentOnTicket(id, fields.comment ?? "", session.email)
      : action === "reassign"
        ? state.reassignTicket(id, fields.assignee ?? "", session.email)
        : action === "label"
          ? state.labelTicket(id, fields.label ?? "", session.email)
          : state.closeTicket(id, session.email);
  if ("error" in result) {
    if (wantsJson(req)) return sendJson(res, 400, { error: result.error });
    return sendHtml(res, 400, ticketPage(ticket, session, undefined, result.error));
  }
  if (wantsJson(req)) return sendJson(res, 200, { ok: true, ticket: result.ticket });
  return redirect(res, `/tickets/${id}`);
}

// ---- /reports ------------------------------------------------------------------------------

function reports(
  state: GoldenSiteState,
  res: ServerResponse,
  method: string,
  session: Session,
): void {
  if (method !== "GET") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  const rows = Object.values(state.data.reports)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(
      (report) =>
        `<tr data-report-month="${report.month}"><td>${report.month}</td><td class="report-total">${money(report.totalRevenue)}</td><td><a href="/reports/export?month=${report.month}">Export CSV</a></td></tr>`,
    )
    .join("\n");
  sendHtml(
    res,
    200,
    page({
      title: "Monthly reports",
      user: session.email,
      body: `<h2 id="page-title">Monthly reports</h2>
<table id="monthly-reports"><thead><tr><th>Month</th><th>Total revenue</th><th>Export</th></tr></thead><tbody>${rows}</tbody></table>`,
    }),
  );
}

function reportExport(state: GoldenSiteState, res: ServerResponse, method: string, url: URL): void {
  if (method !== "GET") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  const month = url.searchParams.get("month") ?? "";
  const report = state.data.reports[month];
  if (!report) {
    sendText(res, 404, `Unknown report month ${month}`);
    return;
  }
  const adjustment = month === "2026-08" ? 4_120.5 : 2_000;
  const subscriptions = report.totalRevenue - adjustment;
  const csv = `date,category,amount\n${month}-01,Subscriptions,${money(subscriptions)}\n${month}-02,Adjustments,${money(adjustment)}\nTOTAL,,${money(report.totalRevenue)}\n`;
  sendCsv(res, `monthly-report-${month}.csv`, csv);
}

// ---- /login ---------------------------------------------------------------------------------

function loginForm(error?: string, next?: string): string {
  return page({
    title: "Log in",
    body: `<h2 id="page-title">Log in</h2>
${errorBox(error)}
<form id="login-form" method="post" action="/login">
  <input type="hidden" name="next" value="${escapeHtml(next ?? "")}">
  <label>Email <input id="email" name="email" type="email" autocomplete="username" required></label>
  <label>Password <input id="password" name="password" type="password" autocomplete="current-password" required></label>
  <button id="login-submit" type="submit">Log in</button>
</form>`,
  });
}

async function login(
  state: GoldenSiteState,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  if (method === "GET")
    return sendHtml(res, 200, loginForm(undefined, url.searchParams.get("next") ?? undefined));
  if (method !== "POST") return sendText(res, 405, "Method not allowed");
  const fields = await readFields(req);
  const session = state.login(fields.email ?? "", fields.password ?? "");
  if (!session) {
    const error = "Invalid email or password.";
    if (wantsJson(req)) return sendJson(res, 401, { error });
    return sendHtml(res, 401, loginForm(error, fields.next));
  }
  const target = session.needsMfa ? "/mfa" : (safeNext(fields.next) ?? "/dashboard");
  if (wantsJson(req)) {
    res.setHeader("set-cookie", sessionCookie(session));
    return sendJson(res, 200, { ok: true, next: target, mfaRequired: session.needsMfa });
  }
  return redirect(res, target, { "set-cookie": sessionCookie(session) });
}

function safeNext(next: string | undefined): string | undefined {
  return next?.startsWith("/") && !next.startsWith("//") ? next : undefined;
}

// ---- /mfa -----------------------------------------------------------------------------------

function mfaForm(error?: string): string {
  return page({
    title: "Two-factor verification",
    body: `<h2 id="page-title">Two-factor verification</h2>
<p>Enter the six-digit code from your authenticator app.</p>
${errorBox(error)}
<form id="mfa-form" method="post" action="/mfa">
  <label>Code <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>
  <button id="mfa-submit" type="submit">Verify</button>
</form>`,
  });
}

async function mfa(
  state: GoldenSiteState,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  session: Session | undefined,
): Promise<void> {
  if (!session) return redirect(res, "/login");
  if (!session.needsMfa || session.mfaPassed) return redirect(res, "/dashboard");
  if (method === "GET") return sendHtml(res, 200, mfaForm());
  if (method !== "POST") return sendText(res, 405, "Method not allowed");
  const fields = await readFields(req);
  if (!state.verifyMfa(session.id, fields.code ?? "")) {
    const error = "Invalid code.";
    if (wantsJson(req)) return sendJson(res, 401, { error });
    return sendHtml(res, 401, mfaForm(error));
  }
  if (wantsJson(req)) return sendJson(res, 200, { ok: true, next: "/dashboard" });
  return redirect(res, "/dashboard");
}

// ---- /logout --------------------------------------------------------------------------------

function logout(
  state: GoldenSiteState,
  res: ServerResponse,
  method: string,
  session: Session | undefined,
): void {
  if (method !== "POST") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  if (session) state.logout(session.id);
  redirect(res, "/login", { "set-cookie": sessionCookie(undefined) });
}

// ---- /dashboard -----------------------------------------------------------------------------

function money(n: number): string {
  return n.toFixed(2);
}

function dashboard(state: GoldenSiteState, res: ServerResponse, session: Session): void {
  const k = state.kpis();
  sendHtml(
    res,
    200,
    page({
      title: "Dashboard",
      user: session.email,
      body: `<h2 id="page-title">Dashboard</h2>
<p id="welcome">Welcome, ${escapeHtml(session.email)}.</p>
<section id="kpis" aria-label="Key metrics">
  <div class="kpi" id="kpi-open-tickets"><div>Open tickets</div><div class="value" id="open-ticket-count">${k.openTickets}</div></div>
  <div class="kpi" id="kpi-orders-today"><div>Orders today</div><div class="value" id="orders-today">${k.ordersToday}</div></div>
  <div class="kpi" id="kpi-month-revenue"><div>This month's revenue</div><div class="value" id="month-revenue">${money(k.monthRevenue)}</div></div>
</section>
<section id="announcement" class="notice" aria-label="Announcement">
  <h3>Announcement</h3>
  <p>${escapeHtml(state.data.announcement)}</p>
</section>`,
    }),
  );
}

// ---- /verify --------------------------------------------------------------------------------

/** Integer in [min, max]. Only ever decides how a glyph is tilted, never what it says. */
function jitter(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

/**
 * The code as a picture: one `<text>` element per character, each tilted on its own, with strike
 * lines across the lot. The characters are laid out by their `x` coordinate and emitted in a
 * shuffled order, so document order is not reading order and no element, attribute or title holds
 * the code as text. The `<svg>` is `aria-hidden`, so the accessibility tree an agent snapshots
 * carries nothing of it either: reading this needs eyes on the screen.
 */
function challengeSvg(code: string): string {
  const width = 240;
  const height = 72;
  const glyphs = [...code].map((ch, i) => {
    const x = 22 + i * 34 + jitter(-4, 4);
    const y = 48 + jitter(-7, 7);
    const angle = jitter(-38, 38);
    const size = 30 + jitter(-4, 7);
    return `<text x="${x}" y="${y}" transform="rotate(${angle} ${x} ${y})" font-family="Georgia, serif" font-size="${size}" fill="#16233d">${escapeHtml(ch)}</text>`;
  });
  for (let i = glyphs.length - 1; i > 0; i--) {
    const j = jitter(0, i);
    const a = glyphs[i] as string;
    const b = glyphs[j] as string;
    glyphs[i] = b;
    glyphs[j] = a;
  }
  const strikes = Array.from({ length: 3 }, () => {
    const y1 = jitter(8, height - 8);
    const y2 = jitter(8, height - 8);
    return `<line x1="0" y1="${y1}" x2="${width}" y2="${y2}" stroke="#7a8aa8" stroke-width="2"/>`;
  });
  return `<svg id="verify-image" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false" style="background:#eef2f8;border:1px solid #ccc">
  ${glyphs.join("\n  ")}
  ${strikes.join("\n  ")}
</svg>`;
}

function verifyForm(state: GoldenSiteState, error?: string): string {
  return `<h2 id="page-title">Human verification</h2>
<p id="verify-hint">The order is held until someone types the six characters shown in the picture. The picture is the only place they appear.</p>
${errorBox(error)}
${challengeSvg(state.humanCheckCode())}
<form id="verify-form" method="post" action="/verify">
  <label>Verification code <input id="verify-code" name="code" maxlength="6" autocomplete="off" autocapitalize="characters" required></label>
  <button id="verify-submit" type="submit">Verify and place the order</button>
</form>`;
}

async function verify(
  state: GoldenSiteState,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  session: Session,
): Promise<void> {
  const render = (status: number, body: string) =>
    sendHtml(res, status, page({ title: "Human verification", user: session.email, body }));
  // Nothing to verify: either the step is off or this session is already through it.
  if (!state.needsHumanCheck(session.id)) return redirect(res, "/checkout");
  if (method === "GET") return render(200, verifyForm(state));
  if (method !== "POST") return sendText(res, 405, "Method not allowed");
  const fields = await readFields(req);
  if (!state.verifyHumanCheck(session.id, fields.code ?? "")) {
    const error = "That code does not match the picture.";
    if (wantsJson(req)) return sendJson(res, 400, { error });
    return render(400, verifyForm(state, error));
  }
  // Verified: place what `/checkout` held back, exactly as `/checkout` would have.
  const pending = state.takePendingOrder(session.id);
  if (!pending) return redirect(res, "/checkout");
  const result = state.placeOrder({ ...pending, by: session.email });
  if ("error" in result) {
    if (wantsJson(req)) return sendJson(res, 400, { error: result.error });
    return render(
      400,
      checkoutForm(result.error, { ...pending, quantity: String(pending.quantity) }),
    );
  }
  if (wantsJson(req)) return sendJson(res, 201, { ok: true, order: result.order });
  return redirect(res, `/checkout?placed=${encodeURIComponent(result.order.id)}`);
}

// ---- /checkout ------------------------------------------------------------------------------

function checkoutForm(error?: string, values: Record<string, string> = {}): string {
  const skuOptions = Object.entries(SKUS)
    .map(
      ([sku, price]) =>
        `<option value="${sku}"${values.sku === sku ? " selected" : ""}>${sku} (${money(price)})</option>`,
    )
    .join("\n    ");
  return `<h2 id="page-title">New order</h2>
${errorBox(error)}
<form id="checkout-form" method="post" action="/checkout">
  <label>Customer id <input id="customer-id" name="customerId" placeholder="C-0002" value="${escapeHtml(values.customerId ?? "")}" required></label>
  <label>SKU <select id="sku" name="sku">
    ${skuOptions}
  </select></label>
  <label>Quantity <input id="quantity" name="quantity" type="number" min="1" max="99" value="${escapeHtml(values.quantity ?? "1")}" required></label>
  <button id="submit-order" type="submit">Submit order</button>
</form>`;
}

async function checkout(
  state: GoldenSiteState,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  session: Session,
  url: URL,
): Promise<void> {
  const render = (status: number, body: string) =>
    sendHtml(res, status, page({ title: "New order", user: session.email, body }));
  if (method === "GET") {
    const placed = url.searchParams.get("placed");
    const order = placed ? state.data.orders[placed] : undefined;
    const confirmation = order
      ? `<p id="order-confirmation" class="notice">Order <strong id="order-id">${escapeHtml(order.id)}</strong> placed for ${escapeHtml(order.customerId)}: ${order.quantity} × ${escapeHtml(order.sku)}, total ${money(order.amount)}.</p>`
      : "";
    return render(200, confirmation + checkoutForm());
  }
  if (method !== "POST") return sendText(res, 405, "Method not allowed");
  const fields = await readFields(req);
  const submitted = {
    customerId: (fields.customerId ?? "").trim(),
    sku: (fields.sku ?? "").trim(),
    quantity: Number(fields.quantity ?? "1"),
  };
  // The human verification step, when it is on: park the order and send the session to `/verify`.
  // Nothing is placed here; `/verify` places it once a person has read the code off the screen.
  if (state.needsHumanCheck(session.id)) {
    state.holdOrder(session.id, submitted);
    if (wantsJson(req))
      return sendJson(res, 200, { ok: false, verifyRequired: true, next: "/verify" });
    return redirect(res, "/verify");
  }
  const result = state.placeOrder({ ...submitted, by: session.email });
  if ("error" in result) {
    if (wantsJson(req)) return sendJson(res, 400, { error: result.error });
    return render(400, checkoutForm(result.error, fields));
  }
  if (wantsJson(req)) return sendJson(res, 201, { ok: true, order: result.order });
  return redirect(res, `/checkout?placed=${encodeURIComponent(result.order.id)}`);
}

// ---- /api/state -----------------------------------------------------------------------------

async function apiState(
  state: GoldenSiteState,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<void> {
  const sub = decodeURIComponent(path.slice("/api/state".length).replace(/^\//, ""));
  if (method === "GET") {
    if (sub === "") return sendJson(res, 200, state.view());
    if (sub === "log") return sendJson(res, 200, state.opLog());
    const value = state.readPath(sub);
    if (value === undefined) return sendJson(res, 404, { error: `No state at ${sub}` });
    return sendJson(res, 200, value);
  }
  if (method === "POST") {
    if (sub === "reset") {
      state.reset();
      return sendJson(res, 200, { ok: true, reset: true });
    }
    if (sub === "") {
      const body = await readBody(req);
      const parsed: unknown = body.length > 0 ? JSON.parse(body) : {};
      const reset =
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { reset?: unknown }).reset === true;
      if (!reset) return sendJson(res, 400, { error: 'POST /api/state expects {"reset":true}' });
      state.reset();
      return sendJson(res, 200, { ok: true, reset: true });
    }
  }
  return sendJson(res, 405, { error: "Method not allowed" });
}
