// `#/integrations`: everything the current workspace's bots can reach beyond the browser, as a
// catalog with three kinds of entry. Apps come from the integration runtime (ADR-0013): adopt one,
// then connect an account with OAuth or an API key; credentials stay in the runtime. Databases
// are receipted connectors (ADR-0012) registered with a URL and a credential the Gateway keeps in
// its secrets store. Channels are operator-side services (ADR-0017, ADR-0019) that bind chats to
// WhatsApp; the Gateway only sees the binding, so this page explains how to start one.

import type {
  AdoptedIntegrationProvider,
  ConnectorRegistration,
  IntegrationCatalog,
  IntegrationCatalogEntry,
  IntegrationConnection,
  WorkspaceId,
} from "@deskmates/contracts";
import { Pager } from "@deskmates/ui";
import { Database, KeyRound, Plug, Search, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient, IntegrationsStatus } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import {
  FEATURED_SERVICES,
  type IntegrationCategory,
  integrationLogoUrl,
  integrationPresentation,
} from "../../integration-catalog.js";
import { PageBar, usePageRangeText } from "../../lib/page-bar.js";
import { type PageResult, usePagedQuery } from "../../lib/use-paged-query.js";
import { NextAction, RoleNote, useCan } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { ChannelIntegrations } from "./channel-integrations.js";

/** The connection name a new account starts with; an identifier the Gateway stores. */
const DEFAULT_CONNECTION_NAME = "main";
/** Examples in the database dialog: identifiers, the same in every language. */
const CONNECTOR_NAME_EXAMPLE = "galaxy-db";
const CONNECTOR_URL_EXAMPLE = "http://connector-postgres:8090";
/** The runtime's provider catalog is release-bounded and paged locally, 24 a page (#113). */
const CATALOG_PAGE_SIZE = 24;
/** A workspace's connected accounts and its databases: 25 a page from the Gateway (#113). */
export const CONNECTION_PAGE_SIZE = 25;
export const CONNECTOR_PAGE_SIZE = 25;

/** A connections page carries the live count of every service over the whole workspace. */
type ConnectionPageResult = PageResult<IntegrationConnection> & {
  liveByService: { service: string; count: number }[];
};
const CATEGORIES: readonly (IntegrationCategory | "all")[] = [
  "all",
  "code",
  "documents",
  "communication",
  "projects",
  "data",
  "other",
];

export function IntegrationsScreen({ api }: { api: ApiClient }) {
  const scope = useWorkspaceScope(api);
  const workspace = scope.current;
  const workspaceId = workspace?.id ?? "";
  const [status, setStatus] = useState<IntegrationsStatus>();
  const [catalog, setCatalog] = useState<IntegrationCatalog>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<IntegrationCategory | "all">("all");
  const [page, setPage] = useState(0);
  const [connecting, setConnecting] = useState<IntegrationCatalogEntry>();
  const [addingDatabase, setAddingDatabase] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canAdopt = useCan("integration.adopt").allowed;
  const canUnadopt = useCan("integration.unadopt").allowed;
  const canConnect = useCan("integration.connect").allowed;
  const canRevoke = useCan("integration.revoke").allowed;
  const canRegister = useCan("connector.register").allowed;
  const t = useT();

  const perform = useCallback(async (operation: () => Promise<void>) => {
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const next = await api.getIntegrations();
    setStatus(next);
    // The catalog is the runtime's long list; when the route is missing or the runtime is down,
    // the adopted providers from the status are still a catalog.
    try {
      setCatalog(await api.getIntegrationCatalog());
    } catch {
      setCatalog({
        configured: next.configured,
        complete: false,
        providers: next.providers.map((p) => ({ ...p, adopted: true })),
      });
    }
  }, [api]);

  // The workspace's live accounts, one page at a time, with the live count of every service over
  // the whole workspace; a provider card's state comes from those counts, never from a page.
  const accounts = usePagedQuery<IntegrationConnection>({
    scopeKey: `integrations.connections:${workspaceId}`,
    limit: CONNECTION_PAGE_SIZE,
    mode: "offset",
    historyKey: "integrations.connections",
    fetchPage: async ({ offset, limit }): Promise<ConnectionPageResult> => {
      if (!workspaceId) return { items: [], total: 0, liveByService: [] };
      const page = await api.listIntegrationConnections(workspaceId as WorkspaceId, {
        status: "live",
        offset,
        limit,
      });
      return { items: page.connections, total: page.total, liveByService: page.liveByService };
    },
  });
  // Registered databases, one page at a time with the honest total. A Gateway without the
  // connector routes reads as none.
  const databases = usePagedQuery<ConnectorRegistration>({
    scopeKey: `integrations.connectors:${workspaceId}`,
    limit: CONNECTOR_PAGE_SIZE,
    mode: "offset",
    historyKey: "integrations.connectors",
    fetchPage: async ({ offset, limit }) => {
      if (!workspaceId) return { items: [], total: 0 };
      try {
        const page = await api.listConnectors(workspaceId as WorkspaceId, { offset, limit });
        return { items: page.connectors, total: page.total };
      } catch {
        return { items: [], total: 0 };
      }
    },
  });
  const reloadAccounts = accounts.reload;
  const reloadDatabases = databases.reload;
  const accountsPage = accounts.page as ConnectionPageResult | undefined;
  const liveByService = useMemo(
    () => new Map((accountsPage?.liveByService ?? []).map((row) => [row.service, row.count])),
    [accountsPage],
  );
  const liveTotal = accountsPage?.total ?? 0;
  const connectorTotal = databases.page?.total ?? 0;
  // Set once a workspace's connections and connectors were read, so "none yet" is a fact.
  const connectionsLoaded =
    Boolean(workspaceId) && accountsPage !== undefined && databases.page !== undefined;
  const accountsError = accounts.error;
  useEffect(() => {
    if (accountsError) setError(errorMessage(accountsError));
  }, [accountsError]);

  useEffect(() => {
    void perform(loadStatus);
  }, [loadStatus, perform]);

  const adopt = (entry: IntegrationCatalogEntry) =>
    void perform(async () => {
      await api.adoptIntegrationProvider(entry.service, entry.displayName);
      await loadStatus();
      setNotice(t("integrations.adopted", { name: entry.displayName }));
    });
  const unadopt = (service: string) =>
    void perform(async () => {
      await api.unadoptIntegrationProvider(service);
      await loadStatus();
    });
  const revoke = (c: IntegrationConnection) =>
    void perform(async () => {
      await api.revokeIntegrationConnection(workspaceId as WorkspaceId, c.id);
      reloadAccounts();
    });

  const q = query.trim().toLocaleLowerCase();
  const allProviders = useMemo(
    () => catalog?.providers ?? status?.providers.map((p) => ({ ...p, adopted: true })) ?? [],
    [catalog, status],
  );
  const featured = useMemo(() => {
    const byService = new Map(
      allProviders.map((provider) => [provider.service.toLocaleLowerCase(), provider]),
    );
    return FEATURED_SERVICES.map((service) => byService.get(service)).filter(
      (provider): provider is IntegrationCatalogEntry => provider !== undefined,
    );
  }, [allProviders]);
  const filteredProviders = useMemo(() => {
    const visible = allProviders.filter(
      (provider) =>
        (category === "all" || integrationPresentation(provider.service).category === category) &&
        (!q || `${provider.displayName} ${provider.service}`.toLocaleLowerCase().includes(q)),
    );
    return visible;
  }, [allProviders, category, q]);
  const pageCount = Math.max(1, Math.ceil(filteredProviders.length / CATALOG_PAGE_SIZE));
  const providers = filteredProviders.slice(
    page * CATALOG_PAGE_SIZE,
    (page + 1) * CATALOG_PAGE_SIZE,
  );
  const rangeText = usePageRangeText();
  const liveCount = (service: string) => liveByService.get(service) ?? 0;
  const adoptedProvider = (service: string): AdoptedIntegrationProvider | undefined =>
    status?.providers.find((p) => p.service === service);

  const unconfigured = status !== undefined && !status.configured;
  const showFeatured =
    !unconfigured && !q && category === "all" && (featured.length > 0 || workspace !== undefined);

  const providerState = (provider: IntegrationCatalogEntry): MessageKey => {
    if (liveCount(provider.service) > 0) return "integrations.state.connected";
    if ((!provider.adopted && !canAdopt) || (provider.adopted && !canConnect))
      return "integrations.state.needsAdmin";
    return "integrations.state.available";
  };

  return (
    <section className="integrations-screen page-container">
      <header className="integrations-header">
        <div>
          <h1>{t("integrations.title")}</h1>
          <p>
            {workspace
              ? t("integrations.intro.named", { workspace: workspace.name })
              : t("integrations.intro.unnamed")}
          </p>
        </div>
        <label className="memory-search integrations-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("integrations.search.label")}
            placeholder={t("integrations.search.placeholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      {connectionsLoaded && liveTotal === 0 && connectorTotal === 0 ? (
        <div className="integration-empty">
          <p className="muted small">{t("integrations.empty.noConnections")}</p>
          {unconfigured ? (
            <NextAction
              action="connector.register"
              does={t("integrations.next.registerDatabase")}
            />
          ) : (
            <NextAction
              action="integration.connect"
              does={t("integrations.next.connectOrRegister")}
            />
          )}
        </div>
      ) : null}

      {showFeatured ? (
        <section
          className="integration-group featured-integrations"
          aria-label={t("integrations.featured.label")}
        >
          <div className="integration-group-head">
            <h2>{t("integrations.featured.title")}</h2>
            <span className="muted small">{t("integrations.featured.intro")}</span>
          </div>
          <ul className="integration-grid featured-grid">
            {featured.map((provider) => {
              const own = liveCount(provider.service);
              const logo = integrationLogoUrl(provider.service);
              return (
                <li key={provider.service} className="integration-card featured-card">
                  <div className="integration-card-head">
                    <span className="integration-mark" aria-hidden="true">
                      {logo ? (
                        <img src={logo} alt="" />
                      ) : (
                        provider.displayName.slice(0, 1).toUpperCase()
                      )}
                    </span>
                    <div className="integration-title">
                      <strong>{provider.displayName}</strong>
                      <span className="muted small">
                        {t(integrationPresentation(provider.service).summary)}
                      </span>
                    </div>
                    <Pill tone={own > 0 ? "success" : "neutral"} dot={own > 0}>
                      {t(providerState(provider))}
                    </Pill>
                  </div>
                  <div className="integration-card-actions">
                    {!provider.adopted && canAdopt ? (
                      <Button
                        variant="outline"
                        type="button"
                        aria-label={t("integrations.apps.adoptNamed", {
                          name: provider.displayName,
                        })}
                        onClick={() => adopt(provider)}
                      >
                        {t("integrations.apps.adopt")}
                      </Button>
                    ) : provider.adopted && provider.authKinds.length > 0 && canConnect ? (
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={t(
                          own > 0
                            ? "integrations.apps.addAccountNamed"
                            : "integrations.apps.connectNamed",
                          { name: provider.displayName },
                        )}
                        onClick={() => setConnecting(provider)}
                      >
                        {own > 0
                          ? t("integrations.apps.addAccount")
                          : t("integrations.apps.connect")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
            {workspace ? (
              <li className="integration-card featured-card">
                <div className="integration-card-head">
                  <span className="integration-mark" aria-hidden="true">
                    <img src="/integration-logos/postgresql.svg" alt="" />
                  </span>
                  <div className="integration-title">
                    <strong>PostgreSQL</strong>
                    <span className="muted small">{t("integrations.summary.database")}</span>
                  </div>
                  <Pill tone={connectorTotal > 0 ? "success" : "neutral"} dot={connectorTotal > 0}>
                    {t(
                      connectorTotal > 0
                        ? "integrations.state.connected"
                        : canRegister
                          ? "integrations.state.available"
                          : "integrations.state.needsAdmin",
                    )}
                  </Pill>
                </div>
                {canRegister ? (
                  <div className="integration-card-actions">
                    <Button
                      variant="outline"
                      type="button"
                      aria-label={t("integrations.databases.registerFeatured")}
                      onClick={() => setAddingDatabase(true)}
                    >
                      {t("integrations.databases.register")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <section className="integration-group" aria-label={t("integrations.apps.label")}>
        <div className="integration-group-head">
          <h2>
            <Plug size={16} /> {t("integrations.apps.title")}
          </h2>
          <span className="muted small">
            {unconfigured
              ? t("integrations.apps.needRuntime")
              : catalog?.complete === false
                ? t("integrations.apps.adoptedOnly")
                : t("integrations.apps.available", { count: filteredProviders.length })}
          </span>
        </div>
        {!unconfigured ? (
          <div className="integration-categories" aria-label={t("integrations.categories.label")}>
            {CATEGORIES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => {
                  setCategory(value);
                  setPage(0);
                }}
              >
                {t(`integrations.categories.${value}` as MessageKey)}
              </button>
            ))}
          </div>
        ) : null}
        {unconfigured ? null : (
          <>
            <RoleNote action="integration.adopt" does={t("integrations.roleNote.adopt")} />
            <RoleNote action="integration.connect" does={t("integrations.roleNote.connect")} />
          </>
        )}
        {unconfigured ? (
          <p className="integration-empty muted small">{t("integrations.apps.unconfigured")}</p>
        ) : null}
        {!unconfigured && filteredProviders.length === 0 && catalog !== undefined ? (
          <p className="integration-empty muted small">
            {q
              ? t("integrations.apps.noMatch", { query })
              : catalog?.complete === false
                ? t("integrations.apps.listUnreadable")
                : t("integrations.apps.noProviders")}
          </p>
        ) : null}
        <ul className="integration-grid" aria-label={t("integrations.apps.gridLabel")}>
          {providers.map((p) => {
            const own = liveCount(p.service);
            const logo = integrationLogoUrl(p.service);
            return (
              <li key={p.service} className={`integration-card${p.adopted ? " adopted" : ""}`}>
                <div className="integration-card-head">
                  <span className="integration-mark" aria-hidden="true">
                    {logo ? <img src={logo} alt="" /> : p.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="integration-title">
                    <strong>{`${p.displayName} (${p.service})`}</strong>
                    <span className="muted small">
                      {p.authKinds.length > 0
                        ? p.authKinds
                            .map((k) =>
                              k === "oauth"
                                ? t("integrations.auth.oauth")
                                : t("integrations.auth.apiKey"),
                            )
                            .join(" · ")
                        : t("integrations.auth.none")}
                    </span>
                  </div>
                  {own > 0 ? (
                    <Pill tone="success" dot>
                      {t("integrations.apps.connected", { count: own })}
                    </Pill>
                  ) : p.adopted ? (
                    <Pill tone="info">{t("integrations.apps.adoptedPill")}</Pill>
                  ) : null}
                </div>
                <div className="integration-card-actions">
                  {p.adopted ? (
                    <>
                      <Button
                        variant={own > 0 ? "outline" : "default"}
                        type="button"
                        disabled={!workspaceId || !canConnect}
                        onClick={() => setConnecting(p)}
                      >
                        {own > 0
                          ? t("integrations.apps.addAccount")
                          : t("integrations.apps.connect")}
                      </Button>
                      {canUnadopt ? (
                        <button
                          type="button"
                          className="link-button small"
                          onClick={() => unadopt(p.service)}
                        >
                          {t("integrations.apps.unadopt", { service: p.service })}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      type="button"
                      disabled={!canAdopt}
                      onClick={() => adopt(p)}
                    >
                      {t("integrations.apps.adopt")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {filteredProviders.length > CATALOG_PAGE_SIZE ? (
          <Pager
            className="integration-pagination"
            label={t("integrations.pagination.label")}
            previousLabel={t("pager.previous")}
            nextLabel={t("pager.next")}
            range={rangeText({
              from: page * CATALOG_PAGE_SIZE + 1,
              to: page * CATALOG_PAGE_SIZE + providers.length,
              total: filteredProviders.length,
              hasMore: page + 1 < pageCount,
            })}
            rangeClassName="muted small"
            hasPrevious={page > 0}
            hasNext={page + 1 < pageCount}
            onPrevious={() => setPage((current) => Math.max(0, current - 1))}
            onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          />
        ) : null}
      </section>

      {accounts.items.length > 0 ? (
        <section className="integration-group" aria-label={t("integrations.accounts.title")}>
          <div className="integration-group-head">
            <h2>
              <KeyRound size={16} /> {t("integrations.accounts.title")}
            </h2>
            <span className="muted small">{t("integrations.accounts.intro")}</span>
          </div>
          <ul className="integration-connections integration-accounts">
            {accounts.items.map((c) => (
              <li key={c.id}>
                <KeyRound size={13} aria-hidden="true" />
                <span>{`${c.service}/${c.connectionName} (${c.authKind})`}</span>
                {canRevoke ? (
                  <button type="button" className="link-button small" onClick={() => revoke(c)}>
                    {t("integrations.connection.revoke", {
                      service: c.service,
                      name: c.connectionName,
                    })}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <PageBar query={accounts} label={t("integrations.accounts.pages")} />
        </section>
      ) : null}

      <section className="integration-group" aria-label={t("integrations.databases.label")}>
        <div className="integration-group-head">
          <h2>
            <Database size={16} /> {t("integrations.databases.title")}
          </h2>
          <span className="muted small">{t("integrations.databases.intro")}</span>
        </div>
        <ul className="integration-grid">
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
                <Database size={16} />
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
                onClick={() => setAddingDatabase(true)}
              >
                {t("integrations.databases.register")}
              </Button>
            </div>
            <RoleNote action="connector.register" does={t("integrations.next.registerDatabase")} />
          </li>
        </ul>
        <PageBar query={databases} label={t("integrations.databases.pages")} />
      </section>

      <ChannelIntegrations api={api} workspaceId={workspaceId} />

      <ConnectDialog
        api={api}
        workspaceId={workspaceId}
        provider={connecting}
        adopted={connecting ? adoptedProvider(connecting.service) : undefined}
        oauthAvailable={status?.oauthAvailable ?? false}
        onClose={() => setConnecting(undefined)}
        onChanged={reloadAccounts}
        onNotice={setNotice}
      />
      <DatabaseDialog
        api={api}
        workspaceId={workspaceId}
        open={addingDatabase}
        onClose={() => setAddingDatabase(false)}
        onCreated={() => {
          setAddingDatabase(false);
          reloadDatabases();
        }}
      />
    </section>
  );
}

/** Connect one account of an adopted app: OAuth in a new tab, or an API key sent once. */
function ConnectDialog({
  api,
  workspaceId,
  provider,
  adopted,
  oauthAvailable,
  onClose,
  onChanged,
  onNotice,
}: {
  api: ApiClient;
  workspaceId: string;
  provider: IntegrationCatalogEntry | undefined;
  adopted: AdoptedIntegrationProvider | undefined;
  oauthAvailable: boolean;
  onClose: () => void;
  onChanged: () => void;
  onNotice: (text: string) => void;
}) {
  const [connectionName, setConnectionName] = useState(DEFAULT_CONNECTION_NAME);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = useT();
  const authKinds = adopted?.authKinds ?? provider?.authKinds ?? [];
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const connectOAuth = () =>
    void run(async () => {
      if (!provider) return;
      const { authorizationUrl } = await api.startOAuthConnection(workspaceId as WorkspaceId, {
        service: provider.service,
        connectionName: connectionName.trim(),
      });
      window.open(authorizationUrl, "_blank", "noopener,noreferrer");
      onNotice(t("integrations.connect.oauthNotice"));
      onClose();
    });
  const saveApiKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      if (!provider) return;
      await api.createApiKeyConnection(workspaceId as WorkspaceId, {
        service: provider.service,
        connectionName: connectionName.trim(),
        apiKey,
      });
      setApiKey("");
      onChanged();
      onClose();
    });
  };
  return (
    <Dialog
      open={provider !== undefined}
      onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}
    >
      <DialogContent className="max-w-md" closeLabel={t("integrations.connect.close")}>
        <DialogTitle className="pr-8 text-lg font-semibold">
          {t("integrations.connect.title", { name: provider?.displayName ?? "" })}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t("integrations.connect.description")}
        </DialogDescription>
        <form
          className="stack"
          onSubmit={saveApiKey}
          aria-label={t("integrations.connect.formLabel")}
        >
          <label>
            {t("integrations.connect.name")}
            <input
              value={connectionName}
              onChange={(e) => setConnectionName(e.target.value)}
              placeholder={DEFAULT_CONNECTION_NAME}
            />
          </label>
          {authKinds.includes("oauth") ? (
            <Button
              type="button"
              variant="default"
              disabled={busy || !oauthAvailable || !workspaceId || connectionName.trim() === ""}
              onClick={connectOAuth}
            >
              {t("integrations.connect.withOAuth")}
            </Button>
          ) : null}
          {authKinds.includes("oauth") && !oauthAvailable ? (
            <p className="muted small">{t("integrations.connect.oauthUnavailable")}</p>
          ) : null}
          {authKinds.includes("api_key") ? (
            <>
              <label>
                {t("integrations.connect.apiKey")}
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
              <Button
                type="submit"
                variant={authKinds.includes("oauth") ? "outline" : "default"}
                disabled={busy || !workspaceId || connectionName.trim() === "" || apiKey === ""}
              >
                {t("integrations.connect.saveApiKey")}
              </Button>
            </>
          ) : null}
          {error ? <p className="error small">{error}</p> : null}
        </form>
      </DialogContent>
    </Dialog>
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
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={CONNECTOR_URL_EXAMPLE}
              required
            />
          </label>
          <label>
            {t("integrations.database.credential")}
            <input
              type="password"
              autoComplete="off"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </label>
          {error ? <p className="error small">{error}</p> : null}
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
