// The app-share domain over one Gateway context (ADR-0035): the store, entry tickets, grants and
// the open connections revocation must reach. One instance per context, shared by the operator
// routes, the bot's internal route and the app listener, without adding to `context.ts`.

import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import {
  type AppShare,
  type AppShareOpenResponse,
  DeskmatesError,
  type WorkspaceId,
  workspaceRoleAtLeast,
} from "@deskmates/contracts";
import type { AppShareConfig } from "../config/app-shares.js";
import type { GatewayContext } from "../context.js";
import { type AppShareRow, AppShareStore, hostLabelOf } from "./app-share-store.js";
import { type RelayTarget, probeRelay } from "./relay-client.js";

export const TICKET_SECONDS = 30;
export const GRANT_MS = 12 * 60 * 60 * 1000;
/** The app origin's cookie; `__Host-` on HTTPS so no sibling host can plant it. */
export const appCookieName = (baseUrl: string): string =>
  baseUrl.startsWith("https:") ? "__Host-deskmates-app" : "deskmates-app";

/** Who an entry ticket or grant stands for: one person's session, in one tenant. */
interface Holder {
  shareId: string;
  userId: string;
  sessionId: string;
  tenantId: string;
  expires: number;
}

export class AppShareModule {
  readonly store: AppShareStore;
  private readonly tickets = new Map<string, Holder & { path: string }>();
  private readonly grants = new Map<string, Holder>();
  private readonly sockets = new Map<string, Set<Socket>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ctx: GatewayContext,
    readonly config: AppShareConfig | undefined,
  ) {
    this.store = new AppShareStore(ctx.db, ctx.audit);
    // Archiving a workspace ends access at once (decision 8).
    this.unsubscribe = ctx.bus.subscribe((event) => {
      if (event.type === "workspace" && event.workspace.archivedAt)
        for (const id of this.store.activeIds(event.workspaceId)) this.disconnect(id);
    });
  }

  enabled(): AppShareConfig {
    if (!this.config)
      throw new DeskmatesError(
        "invalid_transition",
        "app sharing is not configured on this Gateway (APP_SHARE_BASE_URL)",
        { reason: "app_sharing_off" },
      );
    return this.config;
  }

  originOf(row: AppShareRow): string {
    const base = new URL(this.enabled().baseUrl);
    return `${base.protocol}//${hostLabelOf(row.id)}.${base.host}`;
  }

  async relayTarget(workspaceId: string): Promise<RelayTarget | undefined> {
    const workspace = this.ctx.workspaces.get(workspaceId as WorkspaceId);
    if (!workspace || workspace.archivedAt) return undefined;
    const handle = await this.ctx.sandboxes.peek(workspaceId as WorkspaceId);
    return handle && { address: handle.appRelayAddress, key: handle.appRelayKey };
  }

  /** The row as the API shows it; an active row is probed through the relay. */
  async view(row: AppShareRow): Promise<AppShare> {
    const base = {
      id: row.id,
      workspaceId: row.workspaceId,
      port: row.port,
      label: row.label,
      url: this.config ? `${this.originOf(row)}/` : "",
      botId: row.botId,
      runId: row.runId,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      revokedBy: row.revokedBy,
    };
    if (row.revokedAt !== null) return { ...base, state: "revoked" };
    const target = await this.relayTarget(row.workspaceId).catch(() => undefined);
    if (!target) return { ...base, state: "unavailable", reason: "workspace_stopped" };
    const refusal = await probeRelay(target, row.port);
    return refusal
      ? { ...base, state: "unavailable", reason: refusal }
      : { ...base, state: "available" };
  }

  async list(workspaceId: string): Promise<AppShare[]> {
    return Promise.all(this.store.list(workspaceId).map((row) => this.view(row)));
  }

  /** A one-use entry ticket for a signed-in person (decision 3). */
  issueTicket(
    row: AppShareRow,
    holder: { userId: string; sessionId: string; tenantId: string },
    path: string,
  ): AppShareOpenResponse {
    this.enabled();
    if (row.revokedAt !== null) throw new DeskmatesError("not_found", "app share not found");
    this.sweep();
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, {
      ...holder,
      shareId: row.id,
      path,
      expires: Date.now() + TICKET_SECONDS * 1000,
    });
    return {
      enterUrl: `${this.originOf(row)}/__deskmates/enter`,
      ticket,
      expiresIn: TICKET_SECONDS,
    };
  }

  /** Spend a ticket for `row`; a new grant id and the landing path, or undefined. */
  redeem(row: AppShareRow, ticket: string): { grant: string; path: string } | undefined {
    const held = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!held || held.shareId !== row.id || !this.admits(row, held)) return undefined;
    const grant = randomBytes(32).toString("hex");
    this.grants.set(grant, { ...held, expires: Date.now() + GRANT_MS });
    return { grant, path: held.path };
  }

  /** The grant among `values` that admits a request to `row` now, if any. */
  grantFor(row: AppShareRow, values: readonly string[]): Holder | undefined {
    for (const value of values) {
      const grant = this.grants.get(value);
      if (grant && grant.shareId === row.id && this.admits(row, grant)) return grant;
    }
    return undefined;
  }

  /**
   * Decision 3's recheck: the publication is active and its workspace not archived, the session
   * is still signed in to the tenant, and the person still holds Member or above there.
   */
  private admits(row: AppShareRow, holder: Holder): boolean {
    if (holder.expires < Date.now()) return false;
    const current = this.store.get(row.id);
    if (!current || current.revokedAt !== null) return false;
    const workspace = this.ctx.workspaces.get(row.workspaceId as WorkspaceId);
    if (!workspace || workspace.archivedAt) return false;
    if (!this.ctx.auth.sessionStillAuthorized(holder.sessionId, holder.tenantId)) return false;
    try {
      this.ctx.ownership.require(holder.tenantId, "workspace", row.workspaceId);
    } catch {
      return false;
    }
    const role = this.ctx.auth.roleInWorkspace({ userId: holder.userId }, row.workspaceId);
    return role !== undefined && workspaceRoleAtLeast(role, "member");
  }

  /** Register an open connection of `shareId`; revocation and sign-out close it. */
  track(shareId: string, sessionId: string, tenantId: string, socket: Socket): void {
    let set = this.sockets.get(shareId);
    if (!set) {
      set = new Set();
      this.sockets.set(shareId, set);
    }
    set.add(socket);
    const release = this.ctx.auth.live.register(sessionId, () => socket.destroy(), tenantId);
    socket.once("close", () => {
      set.delete(socket);
      release();
    });
  }

  revoke(id: string, actor: string): AppShareRow {
    const row = this.store.revoke(id, actor);
    this.disconnect(id);
    return row;
  }

  /** Drop every ticket and grant of `shareId` and close its open connections. */
  private disconnect(shareId: string): void {
    for (const [key, value] of this.tickets)
      if (value.shareId === shareId) this.tickets.delete(key);
    for (const [key, value] of this.grants) if (value.shareId === shareId) this.grants.delete(key);
    for (const socket of this.sockets.get(shareId) ?? []) socket.destroy();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.tickets) if (value.expires < now) this.tickets.delete(key);
    for (const [key, value] of this.grants) if (value.expires < now) this.grants.delete(key);
  }

  close(): void {
    this.unsubscribe();
    for (const id of this.sockets.keys()) this.disconnect(id);
  }
}

const modules = new WeakMap<GatewayContext, AppShareModule>();

/** The context's app-share module, created on first use. */
export function appSharesOf(ctx: GatewayContext): AppShareModule {
  let module = modules.get(ctx);
  if (!module) {
    module = new AppShareModule(ctx, ctx.config.appShares);
    modules.set(ctx, module);
  }
  return module;
}
