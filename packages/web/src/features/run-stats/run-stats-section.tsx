// Bot editor › Run statistics (ADR-0050 decision 6): whether this bot is given its own read-only
// `run_stats` tool. Off by default; an Owner or Admin turns it on or off; runs already started keep
// what they froze; giving a bot the tool is a strategy change to compare on paired runs. Opening
// the section only reads.

import type { BotDefinition, BotRunStatsSetting } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

export function RunStatsSection(props: Parameters<typeof BotRunStatsSection>[0]) {
  return <BotRunStatsSection key={props.bot.id} {...props} />;
}

function BotRunStatsSection({
  api,
  bot,
}: {
  api: Pick<ApiClient, "getBotRunStats" | "setBotRunStats">;
  bot: Pick<BotDefinition, "id" | "name" | "workspaceId">;
}) {
  const t = useT();
  const canSet = useCan("bot.setRunStats", bot.workspaceId).allowed;
  const [setting, setSetting] = useState<BotRunStatsSetting>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [readRevision, setReadRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: readRevision requests a local retry.
  useEffect(() => {
    let active = true;
    setSetting(undefined);
    setError("");
    api
      .getBotRunStats(bot.id)
      .then((next) => active && setSetting(next))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, bot.id, readRevision]);

  const save = (enabled: boolean) => {
    setBusy(true);
    setError("");
    api
      .setBotRunStats(bot.id, enabled)
      .then(setSetting)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card settings-section" aria-labelledby={`run-stats-title-${bot.id}`}>
      <h3 id={`run-stats-title-${bot.id}`}>{t("runStats.title")}</h3>
      <p className="muted small">{t("runStats.intro", { name: bot.name })}</p>
      {!setting ? (
        error ? null : (
          <p className="muted small">{t("runStats.loading")}</p>
        )
      ) : (
        <>
          <p>
            {t("runStats.state")}:{" "}
            <strong>{setting.enabled ? t("runStats.on") : t("runStats.off")}</strong>
          </p>
          <p className="muted small">{t("runStats.strategyNote")}</p>
          <p className="muted small">{t("runStats.frozen")}</p>
          {canSet ? (
            <div className="settings-actions">
              <Button
                type="button"
                variant={setting.enabled ? "tertiary" : "default"}
                disabled={busy}
                onClick={() => save(!setting.enabled)}
              >
                {setting.enabled ? t("runStats.disable") : t("runStats.enable")}
              </Button>
            </div>
          ) : (
            <RoleNote action="bot.setRunStats" does={t("runStats.roleNote")} allowed={canSet} />
          )}
        </>
      )}
      {error ? (
        <div className="error" role="alert">
          <p>{error}</p>
          {!setting ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setReadRevision((value) => value + 1)}
            >
              {t("runStats.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
