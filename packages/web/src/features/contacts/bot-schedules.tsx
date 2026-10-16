import { type BotDefinition, type CronEntry, nextCronFire, parseCron } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useLocale, useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

// Drafts follow the authenticated client, like SOUL drafts, while switching between bots.
const scheduleDrafts = new WeakMap<ApiClient, Map<BotDefinition["id"], CronEntry[]>>();

function draftsFor(api: ApiClient): Map<BotDefinition["id"], CronEntry[]> {
  let drafts = scheduleDrafts.get(api);
  if (!drafts) {
    drafts = new Map();
    scheduleDrafts.set(api, drafts);
  }
  return drafts;
}

export function BotSchedules({
  api,
  bot,
  timeZone,
  onSaved,
}: {
  api: ApiClient;
  bot: BotDefinition;
  timeZone: string;
  onSaved: (bot: BotDefinition) => void;
}) {
  const [entries, setEntries] = useState(
    () => draftsFor(api).get(bot.id) ?? bot.cron.map((entry) => ({ ...entry })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => new Date());
  const locked = !useCan("bot.configure").allowed;
  const canRunNow = useCan("bot.runCronNow").allowed;
  const t = useT();
  const locale = useLocale();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      setNow(new Date());
      // Cron fires on whole minutes. Re-align after delayed/background timers or clock changes.
      clearTimeout(timer);
      timer = setTimeout(refresh, 60_000 - (Date.now() % 60_000));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const changed = JSON.stringify(entries) !== JSON.stringify(bot.cron);
  const edit = (change: (current: CronEntry[]) => CronEntry[]) => {
    setEntries((current) => {
      const next = change(current);
      draftsFor(api).set(bot.id, next);
      return next;
    });
    setNotice("");
  };

  // ADR-0043 decision 6: a saved entry runs now as a `manual` background run.
  const runNow = async (index: number) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.runCronNow(bot.id, index);
      setNotice(t("botSchedules.runNowStarted", { number: index + 1 }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    try {
      for (const entry of entries) {
        parseCron(entry.schedule);
        if (!entry.prompt.trim()) throw new Error(t("botSchedules.needsInstruction"));
      }
      setBusy(true);
      setError("");
      setNotice("");
      const saved = await api.updateBot(bot.id, {
        cron: entries.map(({ schedule, prompt }) => ({
          schedule: schedule.trim(),
          prompt: prompt.trim(),
        })),
      });
      setEntries(saved.cron.map((entry) => ({ ...entry })));
      draftsFor(api).delete(bot.id);
      onSaved(saved);
      setNotice(t("botSchedules.saved"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="management-subsection"
      aria-label={t("botSchedules.sectionLabel", { name: bot.name })}
    >
      <h3>{t("botSchedules.title")}</h3>
      <p className="muted small">
        {t.rich("botSchedules.intro", {
          name: bot.name,
          timeZone,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      <RoleNote action="bot.configure" does={t("botSchedules.roleNote.does")} />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      {entries.length === 0 ? <p className="muted small">{t("botSchedules.empty")}</p> : null}
      {entries.map((entry, index) => {
        let next: string | undefined;
        try {
          const at = nextCronFire(entry.schedule, now, timeZone);
          next = at?.toLocaleString(locale, { timeZone, timeZoneName: "short" });
        } catch {
          // The input is still an editable draft; validation is shown when it is saved.
        }
        return (
          // Cron entries are identified by array position in the existing Gateway contract.
          // biome-ignore lint/suspicious/noArrayIndexKey: controlled fields have no child-local state.
          <div key={index} className="management-schedule">
            <label>
              {t("botSchedules.cronLabel", { number: index + 1 })}
              <input
                value={entry.schedule}
                disabled={busy || locked}
                placeholder="0 9 * * 1-5"
                onChange={(event) =>
                  edit((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, schedule: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <label>
              {t("botSchedules.promptLabel", { number: index + 1 })}
              <textarea
                value={entry.prompt}
                disabled={busy || locked}
                onChange={(event) =>
                  edit((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, prompt: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <p>
              {bot.pausedAt
                ? t("botSchedules.paused")
                : next
                  ? t("botSchedules.next", { at: next })
                  : t("botSchedules.nextUnavailable")}
            </p>
            {canRunNow ? (
              <Button
                type="button"
                disabled={
                  busy ||
                  bot.pausedAt !== undefined ||
                  JSON.stringify(entry) !== JSON.stringify(bot.cron[index])
                }
                title={
                  bot.pausedAt !== undefined
                    ? t("botSchedules.runNowPaused")
                    : JSON.stringify(entry) !== JSON.stringify(bot.cron[index])
                      ? t("botSchedules.runNowUnsaved")
                      : undefined
                }
                onClick={() => void runNow(index)}
              >
                {t("botSchedules.runNow", { number: index + 1 })}
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={busy || locked}
              onClick={() => edit((current) => current.filter((_, i) => i !== index))}
            >
              {t("botSchedules.remove", { number: index + 1 })}
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        disabled={busy || locked}
        onClick={() => edit((current) => [...current, { schedule: "0 9 * * 1-5", prompt: "" }])}
      >
        {t("botSchedules.add")}
      </Button>
      <Button type="button" disabled={busy || locked || !changed} onClick={() => void save()}>
        {t("botSchedules.save")}
      </Button>
    </section>
  );
}
