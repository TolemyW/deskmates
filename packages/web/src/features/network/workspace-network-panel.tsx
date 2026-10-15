// One workspace's network profiles (ADR-0027 amendment 1 decisions 12 to 14, owner-decided
// 2026-10-14): its grants, the selection among the profiles available there, the open-internet
// switch and the connectivity check. Shared by the Network screen and the workspace detail page;
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
import { Publications, ruleSummary } from "./network-format.js";

type PanelApi = Pick<
  NetworkApi,
  | "getWorkspaceNetwork"
  | "preflightWorkspaceNetwork"
  | "setWorkspaceNetworkProfiles"
  | "setWorkspaceNetworkSettings"
>;

/**
 * The profiles a selection may offer: those available in the workspace, those already selected
 * (kept even when no longer available) and, for the root, `extra` (every profile).
 */
export function selectableProfiles(
  view: WorkspaceNetworkView,
  extra: readonly NetworkProfile[] = [],
): Array<{ id: string; name: string }> {
  const out = new Map<string, string>();
  for (const p of [...view.available, ...extra]) out.set(p.id, p.name);
  for (const s of view.selections) if (!out.has(s.profileId)) out.set(s.profileId, s.profileName);
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function selectionExpiry(view: WorkspaceNetworkView): Record<string, string> {
  return Object.fromEntries(view.selections.map((s) => [s.profileId, s.expiresAt ?? ""]));
}

export function WorkspaceNetworkPanel(props: {
  api: PanelApi;
  workspaceId: WorkspaceId;
  /** Every profile, when the caller is the root and may select any. */
  extraProfiles?: readonly NetworkProfile[];
  note?: string | undefined;
}) {
  const { api, workspaceId } = props;
  const t = useT();
  const [view, setView] = useState<WorkspaceNetworkView>();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // Per-selection expiry (decision 9): a grant ends at the earlier of profile and selection.
  const [expiry, setExpiry] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<NetworkPublication>();
  const [busy, setBusy] = useState(false);

  const show = useCallback((next: WorkspaceNetworkView) => {
    setView(next);
    setChosen(new Set(next.selections.map((s) => s.profileId)));
    setExpiry(selectionExpiry(next));
  }, []);

  useEffect(() => {
    setOutcome(undefined);
    setView(undefined);
    // Through a promise, so a client without this domain is an error line, not a broken page.
    Promise.resolve()
      .then(() => api.getWorkspaceNetwork(workspaceId))
      .then(
        (next) => {
          show(next);
          setError(undefined);
        },
        (err: unknown) => setError(errorMessage(err)),
      );
  }, [api, workspaceId, show]);

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
          const expiresAt = expiry[profileId]?.trim();
          return expiresAt ? { profileId, expiresAt } : { profileId };
        }),
      );
      show(result.network);
      setOutcome(result.publication);
    });
  const toggleOpenInternet = (allowed: boolean) =>
    act(async () => show((await api.setWorkspaceNetworkSettings(workspaceId, allowed)).network));

  const options = view ? selectableProfiles(view, props.extraProfiles) : [];
  return (
    <div className="network-selection">
      {view ? (
        <div>
          <p className="network-badge" data-trusted={view.trustedTest}>
            {view.trustedTest ? t("network.trustedTest") : t("network.noGrants")}
          </p>
          {view.grants.length > 0 ? (
            <>
              <h3>{t("network.grants")}</h3>
              <ul>
                {view.grants.map((grant) => (
                  <li key={ruleSummary(grant)}>
                    <code>{ruleSummary(grant)}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <label className="network-switch">
            <input
              type="checkbox"
              checked={view.profilesOnOpenInternet}
              disabled={busy}
              onChange={(e) => void toggleOpenInternet(e.target.checked)}
            />
            {t("network.openInternetSwitch")}
          </label>
          <p className="network-note">
            {view.openInternet
              ? t("network.openInternetHintOpen")
              : t("network.openInternetHintLocked")}
          </p>
          <fieldset>
            <legend>{t("network.selection")}</legend>
            {options.length === 0 ? <p>{t("network.noneAvailable")}</p> : null}
            {options.map((profile) => (
              <div key={profile.id} className="network-choice">
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(profile.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(profile.id);
                      else next.delete(profile.id);
                      setChosen(next);
                    }}
                  />
                  {profile.name}
                </label>
                {chosen.has(profile.id) ? (
                  <label className="network-expiry">
                    {t("network.selectionExpiresAt")}
                    <input
                      value={expiry[profile.id] ?? ""}
                      onChange={(e) => setExpiry({ ...expiry, [profile.id]: e.target.value })}
                    />
                  </label>
                ) : null}
              </div>
            ))}
          </fieldset>
          {props.note ? <p className="network-note">{props.note}</p> : null}
          <Button disabled={busy} onClick={() => void save()}>
            {t("network.saveSelection")}
          </Button>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {outcome ? <Publications publications={[outcome]} /> : null}
      <Preflight key={workspaceId} api={api} workspaceId={workspaceId} />
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
      <h3>{t("network.preflight.title")}</h3>
      <p>{t("network.preflight.intro")}</p>
      <label>
        {t("network.preflight.url")}
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <Button type="submit" disabled={busy || url.trim() === ""}>
        {t("network.preflight.run")}
      </Button>
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
