// Network profiles (ADR-0027 amendment 1): the administrator account defines named LAN grants and
// selects them per workspace. Authorization is the Gateway's: a refused call shows its message.

import type {
  NetworkProfile,
  NetworkPublication,
  NetworkRule,
  Workspace,
  WorkspaceId,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { NetworkApi } from "./api.js";

type Api = Pick<ApiClient, "listWorkspaces"> & NetworkApi;

const OUTCOME: Record<NetworkPublication["status"], MessageKey> = {
  applied: "network.outcome.applied",
  unchanged: "network.outcome.unchanged",
  not_running: "network.outcome.not_running",
  failed: "network.outcome.failed",
};

const EXAMPLE_RULES: NetworkRule[] = [
  { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] },
];

/** `http 10.20.30.0/24 :23001` or `https console.example.lan→10.0.0.5 :443`. */
export function ruleSummary(rule: NetworkRule): string {
  const target = rule.kind === "subnet" ? rule.cidr : `${rule.hostname}→${rule.address}`;
  return `${rule.schemes.join("/")} ${target} :${rule.ports.join(",")}`;
}

interface Draft {
  id?: string;
  revision?: number;
  name: string;
  description: string;
  expiresAt: string;
  rules: string;
}

const emptyDraft = (): Draft => ({
  name: "",
  description: "",
  expiresAt: "",
  rules: JSON.stringify(EXAMPLE_RULES, null, 2),
});

export function NetworkScreen({ api }: { api: Api }) {
  const t = useT();
  const [profiles, setProfiles] = useState<NetworkProfile[]>();
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [publications, setPublications] = useState<NetworkPublication[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await api.listNetworkProfiles();
      setProfiles(list.profiles);
      setNote(list.note);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<NetworkPublication[] | undefined>) => {
    setBusy(true);
    setError(undefined);
    try {
      setPublications((await action()) ?? []);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (d: Draft) =>
    run(async () => {
      let rules: NetworkRule[];
      try {
        rules = JSON.parse(d.rules) as NetworkRule[];
      } catch (err) {
        throw new Error(t("network.rulesInvalid", { error: errorMessage(err) }));
      }
      const input = {
        name: d.name,
        description: d.description,
        rules,
        ...(d.expiresAt.trim() ? { expiresAt: d.expiresAt.trim() } : {}),
      };
      let result: NetworkPublication[] | undefined;
      if (d.id === undefined) await api.createNetworkProfile(input);
      else result = (await api.replaceNetworkProfile(d.id, input, d.revision)).publications;
      setDraft(undefined);
      return result;
    });

  const remove = (profile: NetworkProfile) => {
    if (!window.confirm(t("network.confirmDelete", { name: profile.name }))) return;
    void run(async () => (await api.deleteNetworkProfile(profile.id)).publications);
  };

  return (
    <section className="workspace-screen resource-page page-container network-page">
      <header className="resource-heading">
        <div className="resource-heading-text">
          <h1>{t("network.title")}</h1>
          <p>{t("network.intro")}</p>
          {note ? <p className="network-note">{note}</p> : null}
        </div>
        <Button disabled={busy} onClick={() => void reload()}>
          {t("network.refresh")}
        </Button>
        <Button disabled={busy} onClick={() => setDraft(emptyDraft())}>
          {t("network.new")}
        </Button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <Publications publications={publications} />
      {draft ? (
        <ProfileForm
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSave={() => void save(draft)}
          onCancel={() => setDraft(undefined)}
        />
      ) : null}
      {profiles === undefined ? (
        <p>{t("network.loading")}</p>
      ) : profiles.length === 0 ? (
        <p>{t("network.empty")}</p>
      ) : (
        <ul className="network-profiles">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <strong>{profile.name}</strong>{" "}
              <span>{t("network.revision", { revision: profile.revision })}</span>{" "}
              <span>
                {profile.expiresAt
                  ? t("network.expires", { date: formatDateTime(profile.expiresAt) })
                  : t("network.persistent")}
              </span>
              {profile.description ? <p>{profile.description}</p> : null}
              <ul>
                {profile.rules.map((rule) => (
                  <li key={ruleSummary(rule)}>
                    <code>{ruleSummary(rule)}</code>
                  </li>
                ))}
              </ul>
              <Button
                disabled={busy}
                onClick={() =>
                  setDraft({
                    id: profile.id,
                    revision: profile.revision,
                    name: profile.name,
                    description: profile.description,
                    expiresAt: profile.expiresAt ?? "",
                    rules: JSON.stringify(profile.rules, null, 2),
                  })
                }
              >
                {t("network.edit")}
              </Button>
              <Button disabled={busy} onClick={() => remove(profile)}>
                {t("network.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <WorkspaceSelection api={api} profiles={profiles ?? []} note={note} />
    </section>
  );
}

function Publications({ publications }: { publications: NetworkPublication[] }) {
  const t = useT();
  if (publications.length === 0) return null;
  return (
    <ul className="network-publications" aria-live="polite">
      {publications.map((p) => (
        <li key={p.workspaceId} data-status={p.status}>
          {t("network.publication", { workspace: p.workspaceId, status: t(OUTCOME[p.status]) })}
          {p.policyHash ? <code> {p.policyHash.slice(0, 12)}</code> : null}
          {p.error ? <span> {p.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ProfileForm(props: {
  draft: Draft;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { draft, onChange } = props;
  const field = (key: "name" | "description" | "expiresAt", label: MessageKey) => (
    <label>
      {t(label)}
      <input value={draft[key]} onChange={(e) => onChange({ ...draft, [key]: e.target.value })} />
    </label>
  );
  return (
    <form
      className="network-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave();
      }}
    >
      {field("name", "network.name")}
      {field("description", "network.description")}
      {field("expiresAt", "network.expiresAt")}
      <label>
        {t("network.rules")}
        <textarea
          rows={8}
          value={draft.rules}
          onChange={(e) => onChange({ ...draft, rules: e.target.value })}
        />
      </label>
      <Button type="submit" disabled={props.busy}>
        {t("network.save")}
      </Button>
      <Button disabled={props.busy} onClick={props.onCancel}>
        {t("network.cancel")}
      </Button>
    </form>
  );
}

function WorkspaceSelection(props: {
  api: Api;
  profiles: NetworkProfile[];
  note?: string | undefined;
}) {
  const { api, profiles } = props;
  const t = useT();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId>();
  const [view, setView] = useState<WorkspaceNetworkView>();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<NetworkPublication>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listWorkspaces().then(
      (list) => {
        setWorkspaces(list);
        setWorkspaceId((current) => current ?? list[0]?.id);
      },
      (err) => setError(errorMessage(err)),
    );
  }, [api]);
  useEffect(() => {
    if (workspaceId === undefined) return;
    setOutcome(undefined);
    api.getWorkspaceNetwork(workspaceId).then(
      (next) => {
        setView(next);
        setChosen(new Set(next.selections.map((s) => s.profileId)));
        setError(undefined);
      },
      (err) => setError(errorMessage(err)),
    );
  }, [api, workspaceId]);

  if (workspaces.length === 0)
    return error ? <p role="alert">{error}</p> : <p>{t("network.noWorkspaces")}</p>;
  const save = async () => {
    if (workspaceId === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.setWorkspaceNetworkProfiles(
        workspaceId,
        [...chosen].map((profileId) => ({ profileId })),
      );
      setView(result.network);
      setOutcome(result.publication);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="network-selection">
      <label>
        {t("network.workspace")}
        <select
          value={workspaceId ?? ""}
          onChange={(e) => setWorkspaceId(e.target.value as WorkspaceId)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      {view ? (
        <div>
          <p className="network-badge" data-trusted={view.trustedTest}>
            {view.trustedTest ? t("network.trustedTest") : t("network.noGrants")}
          </p>
          {view.grants.length > 0 ? (
            <>
              <h2>{t("network.grants")}</h2>
              <ul>
                {view.grants.map((grant) => (
                  <li key={ruleSummary(grant)}>
                    <code>{ruleSummary(grant)}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <fieldset>
            <legend>{t("network.selection")}</legend>
            {profiles.map((profile) => (
              <label key={profile.id}>
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
            ))}
          </fieldset>
          {props.note ? <p className="network-note">{props.note}</p> : null}
          <Button disabled={busy} onClick={() => void save()}>
            {t("network.saveSelection")}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {outcome ? <Publications publications={[outcome]} /> : null}
    </section>
  );
}
