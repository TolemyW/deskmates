// A bot's "Apps this bot may use" (ADR-0055): every app the workspace connected, the default, or
// only some. The Gateway refuses the bot's calls to other apps; a teammate that may use an app can
// still be asked to act, so this is a soft distinction and the section says so.

import type { BotDefinition, IntegrationCatalogEntry, WorkspaceId } from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { connectionsHref } from "../integrations/route.js";

interface AppOption {
  service: string;
  name: string;
  connected: boolean;
}

export function BotApps({
  api,
  bot,
  onSaved,
}: {
  api: ApiClient;
  bot: BotDefinition;
  onSaved: (bot: BotDefinition) => void;
}) {
  const t = useT();
  const canConfigure = useCan("bot.configure", bot.workspaceId).allowed;
  const [options, setOptions] = useState<AppOption[]>();
  const [limited, setLimited] = useState(bot.integrationApps !== undefined);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(bot.integrationApps ?? []));
  const [baseline, setBaseline] = useState<readonly string[] | undefined>(bot.integrationApps);
  const [readError, setReadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setBaseline(bot.integrationApps);
  }, [bot.integrationApps]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries this read.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setReadError("");
    void Promise.all([
      api.getIntegrations(),
      api.getIntegrationCatalog().catch(() => undefined),
      api.listIntegrationConnections(bot.workspaceId as WorkspaceId, { status: "live", limit: 1 }),
    ])
      .then(([status, catalog, page]) => {
        if (!live) return;
        if (!status.configured) {
          setOptions([]);
          return;
        }
        const connected = new Set(page.liveByService.map((row) => row.service));
        const enabled: IntegrationCatalogEntry[] =
          catalog?.providers.filter((provider) => provider.adopted) ??
          status.providers.map((provider) => ({ ...provider, adopted: true }));
        const names = new Map(enabled.map((p) => [p.service, p.displayName]));
        // A service the bot already lists stays visible even if it is no longer enabled.
        for (const service of bot.integrationApps ?? [])
          if (!names.has(service)) names.set(service, service);
        setOptions(
          [...names]
            .map(([service, name]) => ({ service, name, connected: connected.has(service) }))
            .sort(
              (a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name),
            ),
        );
      })
      .catch((err: unknown) => {
        if (live) setReadError(errorMessage(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, bot.workspaceId, bot.integrationApps, revision]);

  // Without an integration runtime, or with no app enabled, there is nothing to choose.
  if (options === undefined)
    return (
      <section className="card settings-section bot-apps" aria-label={t("botApps.title")}>
        <h3>{t("botApps.title")}</h3>
        {readError ? (
          <div role="alert">
            <p>{readError}</p>
            <Button
              type="button"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              {t("botApps.retry")}
            </Button>
          </div>
        ) : (
          <p className="muted small">{t("botApps.loading")}</p>
        )}
      </section>
    );
  if (options.length === 0) return null;
  const selection = limited ? [...chosen].sort() : undefined;
  const changed =
    JSON.stringify(selection) !==
    JSON.stringify(baseline === undefined ? undefined : [...baseline].sort());

  const save = async () => {
    if (pending.current || loading || readError || !canConfigure || !changed) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.updateBot(bot.id, {
        integrationApps: limited
          ? options.map((o) => o.service).filter((s) => chosen.has(s))
          : null,
      });
      setBaseline(saved.integrationApps);
      onSaved(saved);
      setNotice(t("botApps.saved"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="card settings-section bot-apps" aria-labelledby="bot-apps-title">
      <h3 id="bot-apps-title">{t("botApps.title")}</h3>
      <p className="muted small">{t("botApps.intro", { name: bot.name })}</p>
      <RoleNote allowed={canConfigure} action="bot.configure" does={t("botApps.roleNote")} />
      {readError ? (
        <div role="alert">
          <p>{readError}</p>
          <Button
            type="button"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            {t("botApps.retry")}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      <fieldset className="bot-apps-mode" disabled={busy || !canConfigure}>
        <legend className="sr-only">{t("botApps.title")}</legend>
        <label>
          <input
            type="radio"
            name={`bot-apps-${bot.id}`}
            checked={!limited}
            onChange={() => setLimited(false)}
          />{" "}
          {t("botApps.all")}
        </label>
        <label>
          <input
            type="radio"
            name={`bot-apps-${bot.id}`}
            checked={limited}
            onChange={() => setLimited(true)}
          />{" "}
          {t("botApps.only")}
        </label>
      </fieldset>
      {limited ? (
        <fieldset className="bot-apps-list" disabled={busy || !canConfigure}>
          <legend className="sr-only">{t("botApps.only")}</legend>
          {options.map((option) => (
            <label key={option.service}>
              <input
                type="checkbox"
                checked={chosen.has(option.service)}
                onChange={(event) =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(option.service);
                    else next.delete(option.service);
                    return next;
                  })
                }
              />{" "}
              {option.name}
              {option.connected ? null : (
                <span className="muted small"> · {t("botApps.notConnected")}</span>
              )}
            </label>
          ))}
          {chosen.size === 0 ? <p className="muted small">{t("botApps.none")}</p> : null}
        </fieldset>
      ) : null}
      <p className="muted small">{t("botApps.soft")}</p>
      <div className="settings-actions">
        <Button
          type="button"
          variant="default"
          disabled={busy || loading || Boolean(readError) || !canConfigure || !changed}
          onClick={() => void save()}
        >
          {t("botApps.save")}
        </Button>
        <a className="small" href={connectionsHref("apps")}>
          {t("botApps.manage")}
        </a>
      </div>
    </section>
  );
}
