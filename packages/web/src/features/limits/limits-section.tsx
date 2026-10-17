// The workspace's execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2), shown as a section
// of the workspace detail page (ADR-0034 decision 4, `workspaces/detail/limits-section.tsx`): each counter's
// effective value and where it came from, the loop breaker that stands behind them, its volume
// switch and "require a budget for unlimited limits", and an editor for Owners and Admins. A blank
// field inherits the default (the turn budget's is off); `off` needs a monetary budget only while
// the workspace requires one. Opening this section only reads; nothing changes until someone saves.

import {
  WORKSPACE_LIMIT_KEYS,
  WORKSPACE_LIMIT_SWITCH_KEYS,
  type WorkspaceLimitKey,
  type WorkspaceLimitSwitchKey,
  type WorkspaceLimitSwitches,
  type WorkspaceLimitValue,
  type WorkspaceLimitsInput,
  type WorkspaceLimitsView,
} from "@deskmates/contracts";
import { type FormEvent, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

/** The order the counters are shown in: conversation first, then the run. */
const ORDER: readonly WorkspaceLimitKey[] = [
  "turnBudget",
  "relayCountMax",
  "maxTurns",
  "continuationLimit",
  "continuationWindowHours",
];

/** The order the switches are shown in: the breaker rule, then the budget gate. */
const SWITCH_ORDER: readonly WorkspaceLimitSwitchKey[] = ["volumeBreaker", "requireBudgetForOff"];

interface Draft {
  limits: Record<WorkspaceLimitKey, { text: string; off: boolean }>;
  switches: WorkspaceLimitSwitches;
}

function draftOf(view: WorkspaceLimitsView): Draft {
  return {
    limits: Object.fromEntries(
      WORKSPACE_LIMIT_KEYS.map((key) => {
        const stored = view.settings[key];
        return [
          key,
          { text: typeof stored === "number" ? String(stored) : "", off: stored === "off" },
        ];
      }),
    ) as Draft["limits"],
    switches: { ...view.switches },
  };
}

/** The PUT body, or the key whose text is not a whole number in range. */
function inputOf(
  draft: Draft,
  view: WorkspaceLimitsView,
): { input: WorkspaceLimitsInput } | { invalid: WorkspaceLimitKey } {
  const input: WorkspaceLimitsInput = {};
  for (const key of WORKSPACE_LIMIT_KEYS) {
    const { text, off } = draft.limits[key];
    let value: WorkspaceLimitValue | null = null;
    if (off) value = "off";
    else if (text.trim() !== "") {
      const n = Number(text.trim());
      const range = view.ranges[key];
      if (!Number.isInteger(n) || n < range.min || n > range.max) return { invalid: key };
      value = n;
    }
    input[key] = value;
  }
  for (const key of WORKSPACE_LIMIT_SWITCH_KEYS)
    if (draft.switches[key] !== view.switches[key]) input[key] = draft.switches[key];
  return { input };
}

export function LimitsSection({
  api,
  workspaceId,
  readOnly = false,
}: {
  api: ApiClient;
  workspaceId: string;
  /** An archived workspace shows its limits without the editor. */
  readOnly?: boolean;
}) {
  const t = useT();
  const can = useCan("limits.set", workspaceId);
  const canSet = can.allowed && !readOnly;
  const [view, setView] = useState<WorkspaceLimitsView>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setView(undefined);
    setDraft(undefined);
    api
      .getWorkspaceLimits(workspaceId)
      .then((next) => active && setView(next))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, workspaceId]);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!view || !draft) return;
    const result = inputOf(draft, view);
    if ("invalid" in result) {
      const range = view.ranges[result.invalid];
      setError(
        t("limits.invalid", {
          name: t(`limits.key.${result.invalid}`),
          min: range.min,
          max: range.max,
        }),
      );
      return;
    }
    setBusy(true);
    setError("");
    api
      .setWorkspaceLimits(workspaceId, result.input)
      .then((next) => {
        setView(next);
        setDraft(undefined);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const shown = (key: WorkspaceLimitKey) => {
    if (!view) return "";
    const { value, source } = view.effective[key];
    const amount = value === null ? t("limits.off") : String(value);
    return t("limits.effective", { value: amount, source: t(`limits.source.${source}`) });
  };

  const switchLabel = (key: WorkspaceLimitSwitchKey) =>
    t(`limits.switch.${key}`, { botMessages: view?.loopBreaker.botMessages ?? 0 });

  // `off` is open unless this workspace requires a budget for it and has none (decision 39).
  const gated = (switches: WorkspaceLimitSwitches) =>
    switches.requireBudgetForOff && !view?.budgetBackstop;

  return (
    <section
      className="card workspace-detail-section limits-section"
      aria-labelledby={`workspace-limits-title-${workspaceId}`}
    >
      <h3 id={`workspace-limits-title-${workspaceId}`}>{t("limits.title")}</h3>
      <p className="muted small">{t("limits.intro")}</p>
      {!view ? (
        error ? null : (
          <p className="muted small">{t("limits.loading")}</p>
        )
      ) : draft ? (
        <form className="limits-form" onSubmit={save}>
          {ORDER.map((key) => {
            const range = view.ranges[key];
            const offAllowed = range.off && !gated(draft.switches);
            const fallback = view.defaults[key];
            return (
              <div className="limits-field" key={key}>
                <label>
                  {t(`limits.key.${key}`)}
                  <input
                    inputMode="numeric"
                    value={draft.limits[key].text}
                    disabled={draft.limits[key].off}
                    placeholder={t("limits.inherit", {
                      value: fallback === null ? t("limits.off") : fallback,
                    })}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        limits: {
                          ...draft.limits,
                          [key]: { ...draft.limits[key], text: event.target.value },
                        },
                      })
                    }
                  />
                </label>
                {range.off ? (
                  <label className="limits-off">
                    <input
                      type="checkbox"
                      checked={draft.limits[key].off}
                      disabled={!offAllowed && !draft.limits[key].off}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          limits: {
                            ...draft.limits,
                            [key]: { ...draft.limits[key], off: event.target.checked },
                          },
                        })
                      }
                    />
                    {t("limits.off")}
                  </label>
                ) : null}
              </div>
            );
          })}
          <fieldset className="limits-switches">
            {SWITCH_ORDER.map((key) => (
              <label className="limits-off" key={key}>
                <input
                  type="checkbox"
                  checked={draft.switches[key]}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      switches: { ...draft.switches, [key]: event.target.checked },
                    })
                  }
                />
                {switchLabel(key)}
              </label>
            ))}
          </fieldset>
          {gated(draft.switches) ? (
            <p className="muted small">{t("limits.offNeedsBudget")}</p>
          ) : null}
          <div className="limits-actions">
            <Button type="submit" disabled={busy}>
              {t("limits.save")}
            </Button>
            <Button type="button" variant="tertiary" onClick={() => setDraft(undefined)}>
              {t("limits.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="limits-list">
            {ORDER.map((key) => (
              <div key={key}>
                <dt>{t(`limits.key.${key}`)}</dt>
                <dd>{shown(key)}</dd>
              </div>
            ))}
            {SWITCH_ORDER.map((key) => (
              <div key={key}>
                <dt>{switchLabel(key)}</dt>
                <dd>{view.switches[key] ? t("limits.on") : t("limits.off")}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small">
            {t("limits.breaker", {
              relayMax: view.loopBreaker.relayMax,
              repeats: view.loopBreaker.repeats,
            })}
          </p>
          {canSet ? (
            <Button type="button" variant="tertiary" onClick={() => setDraft(draftOf(view))}>
              {t("limits.edit")}
            </Button>
          ) : readOnly ? null : (
            <RoleNote action="limits.set" does={t("limits.roleNote")} allowed={can.allowed} />
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
