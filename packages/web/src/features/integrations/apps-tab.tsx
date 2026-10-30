// Connections › Apps: services the workspace's bots use through the integration runtime
// (ADR-0013). The runtime's catalog can hold hundreds of providers, so the tab is built around why
// people open it (docs/design/connections-redesign-2026-10-22.md, "Apps at scale"): what is in use
// first; a search over the whole catalog; then a short list of apps that can be connected here,
// featured first. Apps nobody here can connect stay out of that list: they appear in search
// results and, for the platform maintainer, under "Include apps not enabled here".

import type {
  AdoptedIntegrationProvider,
  IntegrationCatalog,
  IntegrationCatalogEntry,
  IntegrationConnection,
  WorkspaceId,
} from "@deskmates/contracts";
import { KeyRound, Search } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useTuneView } from "../../lib/interface-view.js";
import { PageBar } from "../../lib/page-bar.js";
import { type PageResult, usePagedQuery } from "../../lib/use-paged-query.js";
import { NextAction, RoleNote, useCan } from "../../state/session-roles.js";

/** The connection name a new account starts with; an identifier the Gateway stores. */
const DEFAULT_CONNECTION_NAME = "main";
/** How many catalog cards show at first, and how many more each "Show more" adds. */
export const APPS_SHOWN_STEP = 24;
/** A workspace's connected accounts: 25 a page from the Gateway (#113). */
export const CONNECTION_PAGE_SIZE = 25;

const CATEGORIES: readonly IntegrationCategory[] = [
  "code",
  "documents",
  "communication",
  "projects",
  "data",
  "other",
];

type ConnectionPageResult = PageResult<IntegrationConnection> & {
  liveByService: { service: string; count: number }[];
};

const featuredRank = (service: string) => {
  const index = (FEATURED_SERVICES as readonly string[]).indexOf(service.toLocaleLowerCase());
  return index === -1 ? FEATURED_SERVICES.length : index;
};

/** Featured apps first, in the release's order, then A to Z. */
export function byFeaturedThenName(a: IntegrationCatalogEntry, b: IntegrationCatalogEntry) {
  return (
    featuredRank(a.service) - featuredRank(b.service) || a.displayName.localeCompare(b.displayName)
  );
}

/**
 * The catalog cards to list: a search looks at every provider; otherwise only the ones that can
 * be connected here and are not connected yet (those are under "In use"), unless the maintainer
 * asked to include the rest.
 */
export function listedApps(
  providers: readonly IntegrationCatalogEntry[],
  options: {
    query: string;
    category: IntegrationCategory | "all";
    includeNotEnabled: boolean;
    connected: (service: string) => boolean;
  },
): IntegrationCatalogEntry[] {
  const q = options.query.trim().toLocaleLowerCase();
  return providers
    .filter((provider) =>
      q
        ? `${provider.displayName} ${provider.service}`.toLocaleLowerCase().includes(q)
        : (provider.adopted || options.includeNotEnabled) && !options.connected(provider.service),
    )
    .filter(
      (provider) =>
        options.category === "all" ||
        integrationPresentation(provider.service).category === options.category,
    )
    .sort(byFeaturedThenName);
}

export function AppsTab({
  api,
  workspaceId,
  onCount,
}: {
  api: ApiClient;
  workspaceId: string;
  /** The number of live accounts, for the tab label. */
  onCount?: (count: number) => void;
}) {
  const t = useT();
  const tune = useTuneView();
  const canAdopt = useCan("integration.adopt").allowed;
  const canUnadopt = useCan("integration.unadopt").allowed;
  const canConnect = useCan("integration.connect").allowed;
  const canRevoke = useCan("integration.revoke").allowed;
  const [status, setStatus] = useState<IntegrationsStatus>();
  const [catalog, setCatalog] = useState<IntegrationCatalog>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<IntegrationCategory | "all">("all");
  const [includeNotEnabled, setIncludeNotEnabled] = useState(false);
  const [shown, setShown] = useState(APPS_SHOWN_STEP);
  const [connecting, setConnecting] = useState<IntegrationCatalogEntry>();
  const connectTrigger = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readError, setReadError] = useState("");
  const [reading, setReading] = useState(true);

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
    // When the catalog route is missing or the runtime is down, the adopted providers from the
    // status are still a catalog.
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
  // the whole workspace; "In use" comes from those counts, never from one page.
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
  const reloadAccounts = accounts.reload;
  const accountsPage = accounts.page as ConnectionPageResult | undefined;
  const liveByService = useMemo(
    () => new Map((accountsPage?.liveByService ?? []).map((row) => [row.service, row.count])),
    [accountsPage],
  );
  const liveTotal = accountsPage?.total;
  useEffect(() => {
    if (liveTotal !== undefined) onCount?.(liveTotal);
  }, [liveTotal, onCount]);
  const refreshCatalog = useCallback(async () => {
    setReadError("");
    setReading(true);
    try {
      await loadStatus();
    } catch (reason) {
      setReadError(errorMessage(reason));
    } finally {
      setReading(false);
    }
  }, [loadStatus]);
  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  // ADR-0055 decision 6: which bots may use each app; absent `integrationApps` is every app.
  const [botApps, setBotApps] = useState<(readonly string[] | undefined)[]>();
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void api
      .getWorkspace(workspaceId as WorkspaceId)
      .then((view) => {
        if (live) setBotApps(view.bots.map((bot) => bot.integrationApps));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, workspaceId]);
  const usedBy = (service: string) => {
    if (!botApps || botApps.length === 0) return "";
    const allowed = botApps.filter((apps) => apps === undefined || apps.includes(service)).length;
    return allowed === botApps.length
      ? t("integrations.apps.usedByAll")
      : t("integrations.apps.usedBy", { count: allowed, total: botApps.length });
  };

  const providers = useMemo(
    () => catalog?.providers ?? status?.providers.map((p) => ({ ...p, adopted: true })) ?? [],
    [catalog, status],
  );
  const liveCount = (service: string) => liveByService.get(service) ?? 0;
  const inUse = providers
    .filter((provider) => liveCount(provider.service) > 0)
    .sort(byFeaturedThenName);
  const options = {
    query,
    includeNotEnabled: includeNotEnabled && canAdopt,
    connected: (service: string) => liveCount(service) > 0,
  };
  const uncategorised = listedApps(providers, { ...options, category: "all" });
  const listed = listedApps(providers, { ...options, category });
  const categoryCount = (value: IntegrationCategory) =>
    uncategorised.filter((p) => integrationPresentation(p.service).category === value).length;
  const adoptedProvider = (service: string): AdoptedIntegrationProvider | undefined =>
    status?.providers.find((p) => p.service === service);
  const unconfigured = status !== undefined && !status.configured;
  const searching = query.trim() !== "";

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

  if (unconfigured)
    return (
      <div className="connections-tab apps-tab" data-testid="apps-tab">
        <div className="integration-empty">
          <p className="small">
            <strong>{t("integrations.apps.needRuntime")}</strong>
          </p>
          <p className="muted small">{t("integrations.apps.unconfigured")}</p>
        </div>
      </div>
    );

  return (
    <div className="connections-tab apps-tab" data-testid="apps-tab">
      <p className="muted small">{t("integrations.apps.tabIntro")}</p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      {reading && !status ? <output>{t("integrations.loading")}</output> : null}
      {readError ? (
        <div role="alert">
          <p>{readError}</p>
          <Button
            type="button"
            variant="outline"
            disabled={reading}
            onClick={() => void refreshCatalog()}
          >
            {t("integrations.retry")}
          </Button>
        </div>
      ) : null}
      {accounts.error ? (
        <div role="alert">
          <p>{errorMessage(accounts.error)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={accounts.loading}
            onClick={reloadAccounts}
          >
            {t("integrations.retry")}
          </Button>
        </div>
      ) : null}

      {inUse.length > 0 ? (
        <section className="integration-group" aria-label={t("integrations.apps.inUse")}>
          <div className="integration-group-head">
            <h2>{t("integrations.apps.inUse")}</h2>
            <span className="muted small">{t("integrations.apps.howBotsUse")}</span>
          </div>
          <ul className="apps-in-use">
            {inUse.map((provider) => (
              <li key={provider.service} className="apps-in-use-row">
                <AppMark provider={provider} />
                <div className="integration-title">
                  <strong>{provider.displayName}</strong>
                  <span className="muted small">
                    {t("integrations.apps.connected", { count: liveCount(provider.service) })}
                    {usedBy(provider.service) ? ` · ${usedBy(provider.service)}` : ""}
                  </span>
                </div>
                {provider.adopted && canConnect && provider.authKinds.length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={t("integrations.apps.addAccountNamed", {
                      name: provider.displayName,
                    })}
                    onClick={(event) => {
                      connectTrigger.current = event.currentTarget;
                      setConnecting(provider);
                    }}
                  >
                    {t("integrations.apps.addAccount")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {accounts.items.length > 0 ? (
            <details className="apps-accounts">
              <summary className="small">{t("integrations.accounts.title")}</summary>
              <ul className="integration-connections integration-accounts">
                {accounts.items.map((c) => (
                  <li key={c.id}>
                    <KeyRound size={13} aria-hidden="true" />
                    <span>{`${c.service}/${c.connectionName}`}</span>
                    <span className="muted small">
                      {c.authKind === "oauth"
                        ? t("integrations.auth.oauth")
                        : t("integrations.auth.apiKey")}
                    </span>
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
            </details>
          ) : null}
        </section>
      ) : null}

      <section className="integration-group" aria-label={t("integrations.apps.label")}>
        <div className="integration-group-head">
          <h2>{searching ? t("integrations.apps.results") : t("integrations.apps.ready")}</h2>
          {catalog?.complete === false ? (
            <span className="muted small">{t("integrations.apps.adoptedOnly")}</span>
          ) : null}
        </div>
        <label className="memory-search integrations-search apps-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("integrations.search.label")}
            placeholder={t("integrations.search.placeholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShown(APPS_SHOWN_STEP);
            }}
          />
        </label>
        <div className="integration-categories" aria-label={t("integrations.categories.label")}>
          <button
            type="button"
            aria-pressed={category === "all"}
            onClick={() => {
              setCategory("all");
              setShown(APPS_SHOWN_STEP);
            }}
          >
            {t("integrations.categories.allCount", { count: uncategorised.length })}
          </button>
          {CATEGORIES.filter((value) => categoryCount(value) > 0 || category === value).map(
            (value) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => {
                  setCategory(value);
                  setShown(APPS_SHOWN_STEP);
                }}
              >
                {t("integrations.categories.withCount", {
                  name: t(`integrations.categories.${value}` as MessageKey),
                  count: categoryCount(value),
                })}
              </button>
            ),
          )}
        </div>
        {canAdopt && tune ? (
          <label className="apps-include-all small">
            <input
              type="checkbox"
              checked={includeNotEnabled}
              onChange={(event) => {
                setIncludeNotEnabled(event.target.checked);
                setShown(APPS_SHOWN_STEP);
              }}
            />{" "}
            {t("integrations.apps.includeNotEnabled")}
          </label>
        ) : null}
        {inUse.length === 0 && accountsPage !== undefined ? (
          <NextAction action="integration.connect" does={t("integrations.next.connectApp")} />
        ) : (
          <RoleNote action="integration.connect" does={t("integrations.roleNote.connect")} />
        )}
        {listed.length === 0 && catalog !== undefined ? (
          <p className="integration-empty muted small">
            {searching
              ? t("integrations.apps.noMatch", { query })
              : catalog.complete === false
                ? t("integrations.apps.listUnreadable")
                : providers.length === 0
                  ? t("integrations.apps.noProviders")
                  : inUse.length > 0 &&
                      providers.every((p) => !p.adopted || liveCount(p.service) > 0)
                    ? t("integrations.apps.allConnected")
                    : t("integrations.apps.noneEnabled")}
          </p>
        ) : null}
        <ul className="integration-grid" aria-label={t("integrations.apps.gridLabel")}>
          {listed.slice(0, shown).map((provider) => {
            const own = liveCount(provider.service);
            return (
              <li
                key={provider.service}
                className={`integration-card${provider.adopted ? " adopted" : ""}`}
              >
                <div className="integration-card-head">
                  <AppMark provider={provider} />
                  <div className="integration-title">
                    <strong>{provider.displayName}</strong>
                    <span className="muted small">
                      {t(integrationPresentation(provider.service).summary)}
                    </span>
                  </div>
                  {own > 0 ? (
                    <Pill tone="success" dot>
                      {t("integrations.apps.connected", { count: own })}
                    </Pill>
                  ) : !provider.adopted ? (
                    <Pill tone="neutral">{t("integrations.apps.needsMaintainer")}</Pill>
                  ) : null}
                </div>
                <div className="integration-card-actions">
                  {provider.adopted && canConnect && provider.authKinds.length > 0 ? (
                    <Button
                      type="button"
                      variant={own > 0 ? "outline" : "default"}
                      disabled={!workspaceId}
                      aria-label={t(
                        own > 0
                          ? "integrations.apps.addAccountNamed"
                          : "integrations.apps.connectNamed",
                        { name: provider.displayName },
                      )}
                      onClick={(event) => {
                        connectTrigger.current = event.currentTarget;
                        setConnecting(provider);
                      }}
                    >
                      {own > 0 ? t("integrations.apps.addAccount") : t("integrations.apps.connect")}
                    </Button>
                  ) : null}
                  {!provider.adopted && canAdopt ? (
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={t("integrations.apps.enableNamed", {
                        name: provider.displayName,
                      })}
                      onClick={() => adopt(provider)}
                    >
                      {t("integrations.apps.enable")}
                    </Button>
                  ) : null}
                  {provider.adopted && canUnadopt && tune ? (
                    <Button type="button" variant="ghost" onClick={() => unadopt(provider.service)}>
                      {t("integrations.apps.unadopt", { service: provider.service })}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {listed.length > shown ? (
          <div className="apps-more">
            <span className="muted small">
              {t("integrations.apps.showing", { shown, total: listed.length })}
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShown((value) => value + APPS_SHOWN_STEP)}
            >
              {t("integrations.apps.showMore")}
            </Button>
          </div>
        ) : null}
      </section>

      <ConnectDialog
        api={api}
        workspaceId={workspaceId}
        provider={connecting}
        adopted={connecting ? adoptedProvider(connecting.service) : undefined}
        oauthAvailable={status?.oauthAvailable ?? false}
        onClose={() => setConnecting(undefined)}
        onCloseAutoFocus={(event) => {
          if (!connectTrigger.current?.isConnected) return;
          event.preventDefault();
          connectTrigger.current.focus();
        }}
        onChanged={reloadAccounts}
        onNotice={setNotice}
      />
    </div>
  );
}

function AppMark({ provider }: { provider: IntegrationCatalogEntry }) {
  const logo = integrationLogoUrl(provider.service);
  return (
    <span className="integration-mark" aria-hidden="true">
      {logo ? <img src={logo} alt="" /> : provider.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Connect one account of an enabled app: OAuth in a new tab, or an API key sent once. */
function ConnectDialog({
  api,
  workspaceId,
  provider,
  adopted,
  oauthAvailable,
  onClose,
  onChanged,
  onNotice,
  onCloseAutoFocus,
}: {
  api: ApiClient;
  workspaceId: string;
  provider: IntegrationCatalogEntry | undefined;
  adopted: AdoptedIntegrationProvider | undefined;
  oauthAvailable: boolean;
  onClose: () => void;
  onChanged: () => void;
  onNotice: (text: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [connectionName, setConnectionName] = useState(DEFAULT_CONNECTION_NAME);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = useT();
  const authKinds = adopted?.authKinds ?? provider?.authKinds ?? [];
  const service = provider?.service;
  // Each opening belongs to one provider; canceled credentials must never follow another app.
  // biome-ignore lint/correctness/useExhaustiveDependencies: service changes start a fresh form.
  useEffect(() => {
    setConnectionName(DEFAULT_CONNECTION_NAME);
    setApiKey("");
    setError("");
  }, [service]);
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
      <DialogContent
        className="max-w-md"
        closeLabel={t("integrations.connect.close")}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogTitle className="pr-8 text-lg font-semibold">
          {t("integrations.connect.title", { name: provider?.displayName ?? "" })}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t("integrations.connect.description")}
        </DialogDescription>
        {provider?.service === "googledrive" ? (
          <p className="muted small">{t("integrations.connect.driveAccess")}</p>
        ) : null}
        <form
          className="stack"
          onSubmit={saveApiKey}
          aria-label={t("integrations.connect.formLabel")}
        >
          <div className="channel-field">
            <label>
              {t("integrations.connect.name")}
              <input
                disabled={busy}
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder={DEFAULT_CONNECTION_NAME}
                aria-describedby="connection-name-help"
              />
            </label>
            <span id="connection-name-help" className="muted small">
              {t("integrations.connect.nameHelp")}
            </span>
          </div>
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
                  disabled={busy}
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
          {error ? (
            <p className="error small" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
