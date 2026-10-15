// The saved versions of a bot's SOUL.md or MEMORY.md (ADR-0043 decision 2): newest first, which
// one the bot's last run used, the line diff between any two (the SOUL-proposal `diffSoulLines`),
// and "restore", which saves the chosen body as a new version. History is never rewritten.

import type {
  BotDefinition,
  BotRuleFile,
  BotRuleVersionList,
  BotRuleVersionSummary,
} from "@deskmates/contracts";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import type { RestoredRuleFile } from "./api.js";
import { SoulDiff } from "./soul-proposal.js";

export function RuleVersions({
  api,
  bot,
  file,
  currentVersion,
  refreshKey,
  disabled = false,
  onRestored,
}: {
  api: ApiClient;
  bot: BotDefinition;
  file: BotRuleFile;
  /** The hash of the body the editor shows; a restore is checked against it. */
  currentVersion: string;
  /** Changes whenever the editor saved, so the list reloads. */
  refreshKey: string;
  /** An unsaved draft in the editor: a restore would replace it, so it waits. */
  disabled?: boolean;
  onRestored: (restored: RestoredRuleFile) => void;
}) {
  const [list, setList] = useState<BotRuleVersionList>();
  const [from, setFrom] = useState<number>();
  const [to, setTo] = useState<number>();
  const [diff, setDiff] = useState<{ before: string; after: string }>();
  const [confirm, setConfirm] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canRestore = useCan("bot.restoreRuleVersion").allowed;
  const t = useT();
  const label = file === "soul" ? "SOUL.md" : "MEMORY.md";

  const load = useCallback(
    () =>
      api
        .listRuleVersions(bot.id, file)
        .then((next) => {
          setList(next);
          const [newest, previous] = next.versions;
          setTo((current) => current ?? newest?.version);
          setFrom((current) => current ?? previous?.version);
        })
        .catch((err: unknown) => setError(errorMessage(err))),
    [api, bot.id, file],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a save elsewhere reloads the list
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    let active = true;
    setDiff(undefined);
    if (from === undefined || to === undefined) return;
    Promise.all([api.getRuleVersion(bot.id, file, from), api.getRuleVersion(bot.id, file, to)])
      .then(([a, b]) => active && setDiff({ before: a.body, after: b.body }))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, bot.id, file, from, to]);

  const restore = async (version: number) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const restored = await api.restoreRuleVersion(bot.id, file, version, currentVersion);
      onRestored(restored);
      setConfirm(undefined);
      setFrom(version);
      setTo(restored.revision);
      setNotice(
        restored.appliesFromNextRun
          ? t("ruleVersions.restoredNextRun", { from: version, to: restored.revision })
          : t("ruleVersions.restored", { from: version, to: restored.revision }),
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const versions = list?.versions ?? [];
  const pick = (version: BotRuleVersionSummary) =>
    `${t("ruleVersions.version", { version: version.version })} · ${formatDateTime(version.createdAt)}`;
  return (
    <details className="settings-advanced rule-versions">
      <summary>
        {t("ruleVersions.summary", { file: label, count: versions.length })}
        {list?.lastRun ? (
          <span className="pill rule-versions-last-run">
            {t("ruleVersions.lastRun", { version: list.lastRun.version })}
          </span>
        ) : null}
      </summary>
      <p className="muted small">{t("ruleVersions.intro", { file: label, name: bot.name })}</p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <output>{notice}</output> : null}
      {versions.length === 0 ? (
        <p className="muted small">{t("ruleVersions.empty", { file: label })}</p>
      ) : (
        <>
          <ol
            className="rule-version-list"
            aria-label={t("ruleVersions.listLabel", { file: label })}
          >
            {versions.map((version) => (
              <li key={version.version}>
                <strong>{t("ruleVersions.version", { version: version.version })}</strong>{" "}
                <span className="muted small">
                  {formatDateTime(version.createdAt)} · {version.createdBy} ·{" "}
                  {t("ruleVersions.bytes", { bytes: version.bytes })}
                  {version.restoredFrom
                    ? ` · ${t("ruleVersions.restoredFrom", { version: version.restoredFrom })}`
                    : ""}
                  {list?.lastRun?.version === version.version
                    ? ` · ${t("ruleVersions.usedByLastRun")}`
                    : ""}
                </span>
                {canRestore && !disabled && version.version !== versions[0]?.version ? (
                  confirm === version.version ? (
                    <span className="management-confirm">
                      {t("ruleVersions.confirmRestore", { version: version.version })}
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => void restore(version.version)}
                      >
                        {t("ruleVersions.restore")}
                      </Button>
                      <Button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>
                        {t("management.cancel")}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm(version.version)}
                    >
                      {t("ruleVersions.restoreVersion", { version: version.version })}
                    </Button>
                  )
                ) : null}
              </li>
            ))}
          </ol>
          {versions.length > 1 ? (
            <div className="rule-version-compare">
              <label>
                {t("ruleVersions.from")}
                <select
                  value={from ?? ""}
                  onChange={(event) => setFrom(Number(event.target.value))}
                >
                  {versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      {pick(version)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("ruleVersions.to")}
                <select value={to ?? ""} onChange={(event) => setTo(Number(event.target.value))}>
                  {versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      {pick(version)}
                    </option>
                  ))}
                </select>
              </label>
              {diff ? (
                <SoulDiff
                  before={diff.before}
                  after={diff.after}
                  label={t("ruleVersions.diffLabel", { from: from ?? "", to: to ?? "" })}
                />
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <RoleNote action="bot.restoreRuleVersion" does={t("ruleVersions.roleNote")} />
    </details>
  );
}
