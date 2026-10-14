// In-memory server state for the golden site: seed data, sessions, and the operation log that
// `/api/state/log` exposes for ordering assertions (benchmark §2.3, §5 `log_order`).

import { randomBytes } from "node:crypto";
import {
  type Account,
  MFA_CODE,
  type Order,
  SKUS,
  type SeedData,
  type Ticket,
  humanCheckCode,
  makeSeed,
} from "./seed.js";

/** Checkout fields parked on the session while the human verification step is outstanding. */
export interface PendingOrder {
  customerId: string;
  sku: string;
  quantity: number;
}

export interface Session {
  id: string;
  email: string;
  needsMfa: boolean;
  mfaPassed: boolean;
  createdAt: string;
  /** Whether this session has been through `/verify`. Always true when the check is off. */
  humanVerified: boolean;
  /** The order `/checkout` held back because the session was not verified yet. */
  pendingOrder?: PendingOrder | undefined;
}

export interface OpLogEntry {
  seq: number;
  op: string;
  details: Record<string, unknown>;
  ts: string;
}

/** Shape returned by `GET /api/state`. Keys are what the oracles address by dotted path. */
export interface StateView {
  customers: SeedData["customers"];
  tickets: SeedData["tickets"];
  orders: SeedData["orders"];
  reports: SeedData["reports"];
  settings: SeedData["settings"];
  /** The most recent session, or a logged-out marker. `mfa_passed` is what oracle S13 reads. */
  session: {
    logged_in: boolean;
    user: string | null;
    mfa_required: boolean;
    mfa_passed: boolean;
    active_sessions: number;
  };
  canvas: { number: number };
  shadow: { approved: boolean };
  session_only: { id: string };
  flaky: { number: number; requests: number };
  outbox: readonly { to: string; subject: string; ts: string }[];
  announcement: string;
  /**
   * The human verification step. Test-only, like the rest of this view: `code` is what the
   * distorted picture on `/verify` spells, which no page ever writes out in text.
   */
  humanCheck: { enabled: boolean; code: string; verifiedSessions: number };
}

export interface GoldenSiteStateOptions {
  /**
   * Turn the human verification step on (`/verify`, off by default). With it on, the first
   * checkout of a session is held back until a person reads the code off the screen.
   */
  humanCheck?: boolean;
}

export class GoldenSiteState {
  private resetAt = new Date();
  data: SeedData = makeSeed(this.resetAt);
  private sessions = new Map<string, Session>();
  private lastSession: Session | undefined;
  private log: OpLogEntry[] = [];
  private nextSeq = 1;
  private nextOrderNumber = 2051;
  flakyRequests = 0;
  canvasNumber = 0;
  shadowApproved = false;
  outbox: { to: string; subject: string; ts: string }[] = [];
  /** Whether `/verify` stands between a session and its first order. Fixed at construction. */
  readonly humanCheck: boolean;
  /** Which code of the seed's sequence `/verify` is showing; a wrong answer advances it. */
  private humanCheckRound = 0;

  constructor(options: GoldenSiteStateOptions = {}) {
    this.humanCheck = options.humanCheck ?? false;
    this.reset();
  }

  /** Restore the seed. Also drops sessions, so a task always starts logged out. */
  reset(): void {
    this.resetAt = new Date();
    this.data = makeSeed(this.resetAt);
    this.sessions.clear();
    this.lastSession = undefined;
    this.log = [];
    this.nextSeq = 1;
    this.nextOrderNumber = 2051;
    this.flakyRequests = 0;
    this.canvasNumber = this.data.canvasNumber;
    this.shadowApproved = false;
    this.outbox = [];
    this.humanCheckRound = 0;
    this.record("reset", {});
  }

  record(op: string, details: Record<string, unknown>): OpLogEntry {
    const entry = { seq: this.nextSeq++, op, details, ts: new Date().toISOString() };
    this.log.push(entry);
    return entry;
  }

  opLog(): readonly OpLogEntry[] {
    return this.log;
  }

  // ---- auth ------------------------------------------------------------------------------

  findAccount(email: string): Account | undefined {
    return this.data.accounts.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
  }

  /** Verify credentials and open a session. Returns undefined on a bad email or password. */
  login(email: string, password: string): Session | undefined {
    const account = this.findAccount(email);
    if (!account || account.password !== password) {
      this.record("login_failed", { email });
      return undefined;
    }
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      email: account.email,
      needsMfa: account.needsMfa,
      mfaPassed: !account.needsMfa,
      createdAt: new Date().toISOString(),
      humanVerified: !this.humanCheck,
    };
    this.sessions.set(session.id, session);
    this.lastSession = session;
    this.record("login", { email: account.email, mfa_required: account.needsMfa });
    return session;
  }

  session(id: string | undefined): Session | undefined {
    return id === undefined ? undefined : this.sessions.get(id);
  }

  /** A session that may see protected pages: logged in and past MFA when it applies. */
  authenticated(id: string | undefined): Session | undefined {
    const s = this.session(id);
    return s?.mfaPassed ? s : undefined;
  }

  verifyMfa(sessionId: string, code: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const ok = code.trim() === MFA_CODE;
    if (ok) s.mfaPassed = true;
    this.record(ok ? "mfa_passed" : "mfa_failed", { email: s.email });
    return ok;
  }

  logout(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    if (this.lastSession?.id === sessionId) this.lastSession = undefined;
    this.record("logout", { email: s.email });
  }

  // ---- human verification ------------------------------------------------------------------

  /** The code `/verify` is showing right now. Deterministic: the seed and the round decide it. */
  humanCheckCode(): string {
    return humanCheckCode(this.humanCheckRound);
  }

  /** Whether this session still has to go through `/verify` before anything is placed. */
  needsHumanCheck(sessionId: string | undefined): boolean {
    if (!this.humanCheck) return false;
    const s = this.session(sessionId);
    return s !== undefined && !s.humanVerified;
  }

  /** Park the checkout fields on the session while the person reads the code off the screen. */
  holdOrder(sessionId: string, pending: PendingOrder): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.pendingOrder = pending;
    this.record("verify", { phase: "required", email: s.email });
  }

  pendingOrder(sessionId: string | undefined): PendingOrder | undefined {
    return this.session(sessionId)?.pendingOrder;
  }

  /**
   * Answer the verification. A right code marks the session verified for good; a wrong one leaves
   * it alone and moves the page on to the next code of the sequence.
   */
  verifyHumanCheck(sessionId: string, code: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const ok = code.trim().toUpperCase() === this.humanCheckCode();
    if (ok) s.humanVerified = true;
    else this.humanCheckRound += 1;
    this.record("verify", { phase: ok ? "passed" : "failed", email: s.email });
    return ok;
  }

  /** Take the parked order off the session; the caller places it. */
  takePendingOrder(sessionId: string): PendingOrder | undefined {
    const s = this.sessions.get(sessionId);
    const pending = s?.pendingOrder;
    if (s) s.pendingOrder = undefined;
    return pending;
  }

  private verifiedSessions(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.humanVerified) n += 1;
    return n;
  }

  // ---- vision-only fixtures ---------------------------------------------------------------

  approveShadow(): void {
    if (this.shadowApproved) return;
    this.shadowApproved = true;
    this.record("shadow_approve", {});
  }

  refreshCanvas(): number {
    this.canvasNumber += 1;
    this.record("canvas_refresh", { number: this.canvasNumber });
    return this.canvasNumber;
  }

  // ---- orders ----------------------------------------------------------------------------

  /** Validate and place an order. Returns an error message on bad input. */
  placeOrder(input: {
    customerId: string;
    sku: string;
    quantity: number;
    by: string;
  }): { order: Order } | { error: string } {
    const customer = this.data.customers[input.customerId];
    if (!customer) return { error: `Unknown customer ${input.customerId}` };
    const unit = SKUS[input.sku];
    if (unit === undefined) return { error: `Unknown SKU ${input.sku}` };
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
      return { error: "Quantity must be an integer from 1 to 99" };
    }
    const order: Order = {
      id: `O-${this.nextOrderNumber++}`,
      customerId: customer.id,
      sku: input.sku,
      quantity: input.quantity,
      amount: Math.round(unit * input.quantity * 100) / 100,
      status: "paid",
      createdAt: new Date().toISOString(),
    };
    this.data.orders[order.id] = order;
    this.record("order_placed", {
      id: order.id,
      customer: customer.id,
      amount: order.amount,
      by: input.by,
    });
    return { order };
  }

  latestOrder(): Order | undefined {
    let latest: Order | undefined;
    for (const o of Object.values(this.data.orders)) {
      if (
        !latest ||
        o.createdAt > latest.createdAt ||
        (o.createdAt === latest.createdAt && o.id > latest.id)
      ) {
        latest = o;
      }
    }
    return latest;
  }

  // ---- tickets ---------------------------------------------------------------------------

  ticket(id: string): Ticket | undefined {
    return this.data.tickets[id];
  }

  /**
   * Add one comment without replacing the ticket object. Each ticket mutation below touches only
   * its own live field, so overlapping requests cannot write a stale ticket snapshot over another
   * request's comment, assignee, labels or status (benchmark X02/X03).
   */
  commentOnTicket(id: string, comment: string, by: string): { ticket: Ticket } | { error: string } {
    const ticket = this.ticket(id);
    if (!ticket) return { error: `Unknown ticket ${id}` };
    const body = comment.trim();
    if (body.length === 0) return { error: "Comment is required" };
    if (body.length > 2_000) return { error: "Comment must be at most 2000 characters" };
    ticket.comments.push(body);
    ticket.updated_at = new Date().toISOString();
    this.record("ticket_comment", { id, comment: body, by });
    return { ticket };
  }

  reassignTicket(id: string, assignee: string, by: string): { ticket: Ticket } | { error: string } {
    const ticket = this.ticket(id);
    if (!ticket) return { error: `Unknown ticket ${id}` };
    const next = assignee.trim().toLowerCase();
    if (!new Set(["li", "wang", "zhang"]).has(next)) {
      return { error: "Assignee must be li, wang, or zhang" };
    }
    ticket.assignee = next;
    ticket.updated_at = new Date().toISOString();
    this.record("ticket_reassign", { id, assignee: next, by });
    return { ticket };
  }

  labelTicket(id: string, label: string, by: string): { ticket: Ticket } | { error: string } {
    const ticket = this.ticket(id);
    if (!ticket) return { error: `Unknown ticket ${id}` };
    const next = label.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(next)) {
      return { error: "Label must start with a letter and use only letters, numbers, or hyphens" };
    }
    if (!ticket.tags.includes(next)) ticket.tags.push(next);
    ticket.updated_at = new Date().toISOString();
    this.record("ticket_label", { id, label: next, by });
    return { ticket };
  }

  closeTicket(id: string, by: string): { ticket: Ticket } | { error: string } {
    const ticket = this.ticket(id);
    if (!ticket) return { error: `Unknown ticket ${id}` };
    ticket.status = "closed";
    ticket.updated_at = new Date().toISOString();
    this.record("ticket_close", { id, by });
    return { ticket };
  }

  // ---- dashboard KPIs --------------------------------------------------------------------

  kpis(now = new Date()): { openTickets: number; ordersToday: number; monthRevenue: number } {
    const today = now.toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    let ordersToday = 0;
    for (const o of Object.values(this.data.orders)) {
      if (o.createdAt.startsWith(today)) ordersToday += 1;
    }
    const openTickets = Object.values(this.data.tickets).filter(
      (ticket) => ticket.status === "open",
    ).length;
    const report = this.data.reports[month] ?? this.data.reports["2026-08"];
    return { openTickets, ordersToday, monthRevenue: report?.totalRevenue ?? 0 };
  }

  // ---- /api/state ------------------------------------------------------------------------

  view(): StateView {
    const s = this.lastSession;
    return {
      customers: this.data.customers,
      tickets: this.data.tickets,
      orders: this.data.orders,
      reports: this.data.reports,
      settings: this.data.settings,
      session: {
        logged_in: s !== undefined,
        user: s?.email ?? null,
        mfa_required: s?.needsMfa ?? false,
        mfa_passed: s?.mfaPassed ?? false,
        active_sessions: this.sessions.size,
      },
      canvas: { number: this.canvasNumber },
      shadow: { approved: this.shadowApproved },
      session_only: { id: this.data.sessionOnlyId },
      flaky: { number: this.data.flakyNumber, requests: this.flakyRequests },
      outbox: this.outbox,
      announcement: this.data.announcement,
      humanCheck: {
        enabled: this.humanCheck,
        code: this.humanCheckCode(),
        // With the step off every session is verified by construction, which would be a
        // meaningless count; only a session that answered `/verify` is counted here.
        verifiedSessions: this.humanCheck ? this.verifiedSessions() : 0,
      },
    };
  }

  /**
   * Read a dotted path, including the `collection.where.<conditions>` form used by M02 and M07.
   * Undefined means the path itself is missing; a valid filter with no matches returns `[]`.
   */
  readPath(path: string): unknown {
    const segments = path.split(".").filter((part) => part.length > 0);
    const whereIndex = segments.indexOf("where");
    let cur: unknown = this.view();
    let start = 0;
    if (whereIndex > 0) {
      for (const seg of segments.slice(0, whereIndex)) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      const conditions = segments[whereIndex + 1];
      if (conditions === undefined) return undefined;
      cur = Object.values(cur as Record<string, unknown>).filter((entry) =>
        this.matchesWhere(entry, conditions),
      );
      start = whereIndex + 2;
    }
    for (const seg of segments.slice(start)) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  }

  private matchesWhere(entry: unknown, expression: string): boolean {
    if (entry === null || typeof entry !== "object") return false;
    const item = entry as Record<string, unknown>;
    return expression.split(",").every((condition) => {
      const age = condition.match(/^([^=~<>]+)([<>])(\d+)d$/);
      if (age) {
        const [, field = "", operator = "", daysText = ""] = age;
        const timestamp = item[field];
        if (typeof timestamp !== "string") return false;
        const ageDays = (this.resetAt.getTime() - Date.parse(timestamp)) / (24 * 60 * 60 * 1000);
        const days = Number(daysText);
        return operator === ">" ? ageDays > days : ageDays < days;
      }
      const contains = condition.match(/^([^=~<>]+)~(.*)$/);
      if (contains) {
        const [, field = "", wanted = ""] = contains;
        const value = item[field];
        if (Array.isArray(value)) {
          return value.some((part) => typeof part === "string" && part.includes(wanted));
        }
        return typeof value === "string" && value.includes(wanted);
      }
      const equals = condition.match(/^([^=~<>]+)=(.*)$/);
      if (!equals) return false;
      const [, field = "", wanted = ""] = equals;
      return String(item[field]) === wanted;
    });
  }
}
