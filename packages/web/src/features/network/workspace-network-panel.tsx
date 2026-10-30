// One workspace's network profiles (ADR-0027 amendment 1 decisions 12 to 14, owner-decided
// 2026-10-14): the profiles it may select, each a checkbox with its targets and expiry (an
// expired one is shown but cannot be chosen), the open-internet switch, Apply, and the
// connectivity check folded away. Shared by the Network screen and the workspace detail page;
// the Gateway decides who may change what and a refusal shows its message.

import type {
  NetworkLayer,
  NetworkPreflightResult,
  NetworkProfile,
  NetworkPublication,
  WorkspaceId,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { NetworkApi } from "./api.js";
import { Expiry, Publications, isExpired, ruleSummary } from "./network-format.js";
import { fromLocalInput, toLocalInput } from "./profile-form.js";

type PanelApi = Pick<
  NetworkApi,
  | "getWorkspaceNetwork"
  | "preflightWorkspaceNetwork"
  | "setWorkspaceNetworkProfiles"
  | "setWorkspaceNetworkSettings"
>;

export interface SelectableProfile {
  id: string;
  name: string;
  /** Known for an available profile; a selection whose profile is gone has none. */
  profile?: NetworkProfile;
}

/**
 * The profiles a selection may offer: those available in the workspace, those already selected
 * (kept even when no longer available) and, for the root, `extra` (every profile).
 */
export function selectableProfiles(
  view: WorkspaceNetworkView,
  extra: readonly NetworkProfile[] = [],
): SelectableProfile[] {
  const out = new Map<string, SelectableProfile>();
  for (const p of [...view.available, ...extra])
    out.set(p.id, { id: p.id, name: p.name, profile: p });
  for (const s of view.selections)
    if (!out.has(s.profileId)) out.set(s.profileId, { id: s.profileId, name: s.profileName });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function selectionExpiry(view: WorkspaceNetworkView): Record<string, string> {
  return Object.fromEntries(view.selections.map((s) => [s.profileId, toLocalInput(s.expiresAt)]));
}

interface WorkspaceNetworkPanelProps {
  api: PanelApi;
  workspaceId: WorkspaceId;
  /** Every profile, when the caller is the root and may select any. */
  extraProfiles?: readonly NetworkProfile[];
  note?: string | undefined;
}

export function WorkspaceNetworkPanel(props: WorkspaceNetworkPanelProps) {
  return <ScopedNetworkPanel key={props.workspaceId} {...props} />;
}

function ScopedNetworkPanel(props: WorkspaceNetworkPanelProps) {
  const { api, workspaceId } = props;
  const t = useT();
  const [view, setView] = useState<WorkspaceNetworkView>();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // Per-selection expiry (decision 9): a grant ends at the earlier of profile and selection.
  const [expiry, setExpiry] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<NetworkPublication>();
  const [busy, setBusy] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);

  const show = useCallback((next: WorkspaceNetworkView) => {
    setView(next);
    setChosen(new Set(next.selections.map((s) => s.profileId)));
    setExpiry(selectionExpiry(next));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRevision requests a local retry.
  useEffect(() => {
    let active = true;
    setError(undefined);
    setOutcome(undefined);
    setView(undefined);
    // Through a promise, so a client without this domain is an error line, not a broken page.
    Promise.resolve()
      .then(() => api.getWorkspaceNetwork(workspaceId))
      .then(
        (next) => {
          if (active) show(next);
        },
        (err: unknown) => {
          if (active) setError(errorMessage(err));
        },
      );
    return () => {
      active = false;
    };
  }, [api, workspaceId, show, loadRevision]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      const result = await api.setWorkspaceNetworkProfiles(
        workspaceId,
        [...chosen].map((profileId) => {
          const expiresAt = fromLocalInput(expiry[profileId] ?? "");
          return expiresAt ? { profileId, expiresAt } : { profileId };
        }),
      );
      show(result.network);
      setOutcome(result.publication);
    });
  const toggleOpenInternet = (allowed: boolean) =>
    act(async () => setView((await api.setWorkspaceNetworkSettings(workspaceId, allowed)).network));

  const options = view ? selectableProfiles(view, props.extraProfiles) : [];
  const dirty =
    view !== undefined &&
    (chosen.size !== view.selections.length ||
      view.selections.some((s) => !chosen.has(s.profileId)) ||
      Object.entries(expiry).some(
        ([id, at]) => chosen.has(id) && at !== selectionExpiry(view)[id],
      ));
  return (
    <div className="network-selection">
      {!view && !error ? <output>{t("network.loading")}</output> : null}
      {view ? (
        <>
          <p className="network-badge" data-trusted={view.trustedTest}>
            {view.trustedTest ? t("network.trustedTest") : t("network.noGrants")}
          </p>
          {options.length === 0 ? <p className="muted">{t("network.empty")}</p> : null}
          <ul className="network-choices" aria-label={t("network.selection")}>
            {options.map((option) => {
              const expired = isExpired(option.profile?.expiresAt);
              const selected = chosen.has(option.id);
              return (
                <li
                  key={option.id}
                  className="network-choice"
                  data-expired={expired}
                  data-selected={selected}
                >
                  <label className="network-choice-main">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={busy || (expired && !selected)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(option.id);
                        else next.delete(option.id);
                        setChosen(next);
                      }}
                    />
                    <span className="network-choice-name">{option.name}</span>
                    {option.profile ? (
                      <span className="network-choice-targets">
                        {option.profile.rules.map((rule) => (
                          <code key={ruleSummary(rule)}>{ruleSummary(rule)}</code>
                        ))}
                      </span>
                    ) : null}
                    {option.profile ? (
                      <span className="network-choice-expiry">
                        <Expiry expiresAt={option.profile.expiresAt} />
                      </span>
                    ) : null}
                  </label>
                  {selected ? (
                    <label className="network-expiry">
                      {t("network.selectionEnds")}
                      <input
                        type="datetime-local"
                        disabled={busy}
                        value={expiry[option.id] ?? ""}
                        onChange={(e) => setExpiry({ ...expiry, [option.id]: e.target.value })}
                      />
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <label className="network-switch">
            <input
              type="checkbox"
              checked={view.profilesOnOpenInternet}
              disabled={busy}
              onChange={(e) => void toggleOpenInternet(e.target.checked)}
            />
            {t("network.openInternetSwitch")}
          </label>
          <p className="network-note muted small">
            {view.openInternet
              ? t("network.openInternetHintOpen")
              : t("network.openInternetHintLocked")}
          </p>
          <div className="network-apply">
            <Button disabled={busy || !dirty} onClick={() => void save()}>
              {t("network.apply")}
            </Button>
            <span className="muted small">{props.note ?? t("network.applyNote")}</span>
          </div>
        </>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          {error}
          {!view ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setLoadRevision((value) => value + 1)}
            >
              {t("network.refresh")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {outcome ? <Publications publications={[outcome]} /> : null}
      <details className="network-preflight-block">
        <summary>{t("network.preflight.title")}</summary>
        <Preflight key={workspaceId} api={api} workspaceId={workspaceId} />
      </details>
    </div>
  );
}

const LAYER: Record<NetworkLayer, MessageKey> = {
  policy: "network.preflight.layer.policy",
  route: "network.preflight.layer.route",
  dns: "network.preflight.layer.dns",
  tcp: "network.preflight.layer.tcp",
  tls: "network.preflight.layer.tls",
  http: "network.preflight.layer.http",
};

/** Decision 14: one URL checked from the workspace's proxy, each layer's verdict shown. */
function Preflight({ api, workspaceId }: { api: PanelApi; workspaceId: WorkspaceId }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<NetworkPreflightResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await api.preflightWorkspaceNetwork(workspaceId, url.trim()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="network-preflight"
      onSubmit={(e) => {
        e.preventDefault();
        void check();
      }}
    >
      <p className="muted small">{t("network.preflight.intro")}</p>
      <div className="network-preflight-row">
        <input
          type="url"
          aria-label={t("network.preflight.url")}
          value={url}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value);
            setResult(undefined);
            setError(undefined);
          }}
        />
        <Button type="submit" disabled={busy || url.trim() === ""}>
          {t("network.preflight.run")}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <div aria-live="polite">
          <p className="network-preflight-verdict" data-ok={result.ok}>
            {result.failedLayer
              ? t("network.preflight.failed", { layer: t(LAYER[result.failedLayer]) })
              : result.status === undefined
                ? t("network.preflight.okPolicy")
                : t("network.preflight.ok", { status: result.status })}
          </p>
          <ul>
            {result.layers.map((layer) => (
              <li key={layer.layer} data-ok={layer.ok}>
                <strong>{t(LAYER[layer.layer])}</strong>{" "}
                {layer.ok ? t("network.preflight.pass") : t("network.preflight.fail")}
                {layer.detail ? <span> {layer.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
