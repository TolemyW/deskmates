// Connections › Databases (Tune view): receipted connectors (ADR-0012). An Owner or Admin
// registers one with a URL and a credential the Gateway keeps in its secrets store; a bot names it
// in its connectors list to use it.

import type { ConnectorRegistration, WorkspaceId } from "@deskmates/contracts";
import { Database, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

/** Examples in the database dialog: identifiers, the same in every language. */
const CONNECTOR_NAME_EXAMPLE = "galaxy-db";
const CONNECTOR_URL_EXAMPLE = "http://connector-postgres:8090";
/** A workspace's databases: 25 a page from the Gateway (#113). */
export const CONNECTOR_PAGE_SIZE = 25;

export function DatabasesTab({
  api,
  workspaceId,
  onCount,
}: {
  api: ApiClient;
  workspaceId: string;
  onCount?: (count: number) => void;
}) {
  const t = useT();
  const canRegister = useCan("connector.register").allowed;
  const [adding, setAdding] = useState(false);
  // Registered databases, one page at a time. Failed reads stay distinct from an empty list.
  const databases = usePagedQuery<ConnectorRegistration>({
    scopeKey: `integrations.connectors:${workspaceId}`,
    limit: CONNECTOR_PAGE_SIZE,
    mode: "offset",
    historyKey: "integrations.connectors",
    fetchPage: async ({ offset, limit }) => {
      if (!workspaceId) return { items: [], total: 0 };
      const page = await api.listConnectors(workspaceId as WorkspaceId, { offset, limit });
      return { items: page.connectors, total: page.total };
    },
  });
  const total = databases.page?.total;
  useEffect(() => {
    if (total !== undefined) onCount?.(total);
  }, [total, onCount]);

  return (
    <div className="connections-tab" data-testid="databases-tab">
      <p className="muted small">{t("integrations.databases.intro")}</p>
      {databases.loading ? <output>{t("integrations.loading")}</output> : null}
      {databases.error ? (
        <div role="alert">
          <p>{errorMessage(databases.error)}</p>
          <Button
            type="button"
            variant="outline"
            onClick={databases.reload}
            disabled={databases.loading}
          >
            {t("integrations.retry")}
          </Button>
        </div>
      ) : null}
      <ul className="integration-grid" aria-label={t("integrations.databases.label")}>
        {databases.items.map((c) => (
          <li key={c.id} className="integration-card adopted">
            <div className="integration-card-head">
              <span className="integration-mark" aria-hidden="true">
                <Database size={16} />
              </span>
              <div className="integration-title">
                <strong>{c.name}</strong>
                <span className="muted small">
                  {c.publicUrl
                    ? t("integrations.databases.publicUrl", { kind: c.kind })
                    : t("integrations.databases.privateNetwork", { kind: c.kind })}
                </span>
              </div>
              <Pill tone="success" dot>
                {t("integrations.databases.registered")}
              </Pill>
            </div>
            <p className="muted small">
              {t.rich("integrations.databases.usage", {
                name: c.name,
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
          </li>
        ))}
        <li className="integration-card add">
          <div className="integration-card-head">
            <span className="integration-mark" aria-hidden="true">
              <img src="/integration-logos/postgresql.svg" alt="" />
            </span>
            <div className="integration-title">
              <strong>PostgreSQL</strong>
              <span className="muted small">{t("integrations.databases.anyPostgres")}</span>
            </div>
          </div>
          <p className="muted small">{t("integrations.databases.addIntro")}</p>
          <div className="integration-card-actions">
            <Button
              variant="outline"
              type="button"
              disabled={!workspaceId || !canRegister}
              onClick={() => setAdding(true)}
            >
              {t("integrations.databases.register")}
            </Button>
          </div>
          <RoleNote action="connector.register" does={t("integrations.next.registerDatabase")} />
        </li>
      </ul>
      <PageBar query={databases} label={t("integrations.databases.pages")} />
      <DatabaseDialog
        api={api}
        workspaceId={workspaceId}
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => {
          setAdding(false);
          databases.reload();
        }}
      />
    </div>
  );
}

/** Register a receipted connector (ADR-0012). The URL and credential go to the secrets store. */
function DatabaseDialog({
  api,
  workspaceId,
  open,
  onClose,
  onCreated,
}: {
  api: ApiClient;
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (connector: ConnectorRegistration) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = useT();
  useEffect(() => {
    if (open) return;
    setName("");
    setUrl("");
    setCredential("");
    setError("");
  }, [open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await api.registerConnector({
        workspaceId: workspaceId as WorkspaceId,
        name: name.trim(),
        kind: "database",
        url: url.trim(),
        ...(credential ? { credential } : {}),
      });
      setName("");
      setUrl("");
      setCredential("");
      onCreated(created);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent className="max-w-md" closeLabel={t("integrations.database.close")}>
        <DialogTitle className="pr-8 text-lg font-semibold">
          {t("integrations.database.title")}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t("integrations.database.description")}
        </DialogDescription>
        <form className="stack" onSubmit={submit} aria-label={t("integrations.database.formLabel")}>
          <label>
            {t("integrations.database.name")}
            <input
              disabled={busy}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={CONNECTOR_NAME_EXAMPLE}
              pattern="[A-Za-z0-9_\-]+"
              required
            />
          </label>
          <label>
            {t("integrations.database.url")}
            <input
              disabled={busy}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={CONNECTOR_URL_EXAMPLE}
              required
            />
          </label>
          <label>
            {t("integrations.database.credential")}
            <input
              disabled={busy}
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </label>
          {error ? (
            <p className="error small" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              <X size={14} /> {t("integrations.database.cancel")}
            </Button>
            <Button type="submit" variant="default" disabled={busy || !name.trim() || !url.trim()}>
              {t("integrations.database.register")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
