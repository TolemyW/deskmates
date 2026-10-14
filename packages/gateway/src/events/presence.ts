// Who is watching (ADR-0002 definitions): an open `/api/events` stream is a human online. Since
// ADR-0022 a stream counts only for the tenant it was opened in, so another tenant's watcher
// never keeps an approval of this tenant waiting live. Any member of the tenant counts: every
// member may decide its approvals (ADR-0002 amendment 2).

export class Presence {
  /** Open streams per tenant; `undefined` holds streams with no tenant (callers before tenants). */
  private readonly byTenant = new Map<string | undefined, number>();
  private total = 0;

  /** Call on an opened `/api/events` connection; the returned function closes it, once. */
  open(tenantId?: string): () => void {
    this.total += 1;
    this.byTenant.set(tenantId, (this.byTenant.get(tenantId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.total -= 1;
      const left = (this.byTenant.get(tenantId) ?? 1) - 1;
      if (left === 0) this.byTenant.delete(tenantId);
      else this.byTenant.set(tenantId, left);
    };
  }

  /** Open streams of one tenant (or of no tenant). */
  streams(tenantId?: string): number {
    return this.byTenant.get(tenantId) ?? 0;
  }

  get connections(): number {
    return this.total;
  }

  /**
   * Whether a human is watching. With a tenant, only that tenant's streams count; without one
   * (callers that predate tenants), any stream does.
   */
  humanOnline(tenantId?: string): boolean {
    if (tenantId === undefined) return this.total > 0;
    return (this.byTenant.get(tenantId) ?? 0) > 0;
  }
}
