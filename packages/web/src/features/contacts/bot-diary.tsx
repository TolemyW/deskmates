// The bot's own diary (ADR-0043 decision 4): `/home/<bot>/memory/YYYY-MM-DD.md`, one line per
// finished run, the last three days of which open every run. Read-only here except for deleting
// one line at a time, which the Gateway audits. The files live in the workspace container, so a
// stopped workspace shows why there is nothing to read.

import type { BotDefinition, BotDiaryDay, BotDiaryDaySummary } from "@deskmates/contracts";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

export function BotDiary({ api, bot }: { api: ApiClient; bot: BotDefinition }) {
  const [days, setDays] = useState<BotDiaryDaySummary[]>();
  const [day, setDay] = useState<BotDiaryDay>();
  const [confirm, setConfirm] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEdit = useCan("bot.editDiary", bot.workspaceId).allowed;
  const t = useT();

  const open = useCallback(
    async (name: string) => {
      setError("");
      setConfirm(undefined);
      try {
        setDay(await api.readDiaryDay(bot.id, name));
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [api, bot.id],
  );

  const reload = useCallback(async () => {
    setError("");
    try {
      const listed = await api.listDiaryDays(bot.id);
      setDays(listed);
      const newest = listed[0];
      if (newest) await open(newest.day);
      else setDay(undefined);
    } catch (err) {
      setDays([]);
      setError(errorMessage(err));
    }
  }, [api, bot.id, open]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (index: number, text: string) => {
    if (!day) return;
    setBusy(true);
    setError("");
    try {
      setDay(
        await api.deleteDiaryLine(bot.id, day.day, { line: index, text, version: day.version }),
      );
      setConfirm(undefined);
    } catch (err) {
      setError(errorMessage(err));
      // The day changed underneath (the bot appended): show what is there now.
      await open(day.day);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bot-diary" aria-label={t("botDiary.label", { name: bot.name })}>
      <h3>{t("botDiary.title")}</h3>
      <p className="muted small">{t("botDiary.intro", { name: bot.name })}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="bot-diary-days">
        {(days ?? []).map((item) => (
          <Button
            key={item.day}
            type="button"
            aria-pressed={day?.day === item.day}
            onClick={() => void open(item.day)}
          >
            {item.day}
          </Button>
        ))}
        <Button type="button" variant="ghost" onClick={() => void reload()}>
          {t("botDiary.reload")}
        </Button>
      </div>
      {days !== undefined && days.length === 0 && !error ? (
        <p className="muted small">{t("botDiary.empty")}</p>
      ) : null}
      {day ? (
        <ol className="bot-diary-lines" aria-label={t("botDiary.dayLabel", { day: day.day })}>
          {day.lines.map((line, index) => (
            // Lines are positional; a delete reloads the whole day.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diary lines
            <li key={index}>
              <code>{line}</code>
              {canEdit && line.trim() !== "" ? (
                confirm === index ? (
                  <span className="management-confirm">
                    {t("botDiary.confirmDelete")}
                    <Button type="button" disabled={busy} onClick={() => void remove(index, line)}>
                      {t("botDiary.delete")}
                    </Button>
                    <Button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>
                      {t("management.cancel")}
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("botDiary.deleteLine", { number: index + 1 })}
                    onClick={() => setConfirm(index)}
                  >
                    {t("botDiary.delete")}
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <RoleNote allowed={canEdit} action="bot.editDiary" does={t("botDiary.roleNote")} />
    </section>
  );
}
