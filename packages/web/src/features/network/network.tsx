// Network profiles (ADR-0027 amendment 1, decisions 12 and 13 owner-decided 2026-10-14): the
// administrator account and workspace Owners define named LAN grants; a workspace's Admins select
// them. Authorization is the Gateway's: a refused call shows its message.

import type {
  NetworkOverlap,
  NetworkProfile,
  NetworkPublication,
  NetworkRule,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { NetworkApi } from "./api.js";
import { Publications, ruleSummary } from "./network-format.js";
import { WorkspaceNetworkPanel } from "./workspace-network-panel.js";

export { ruleSummary } from "./network-format.js";

type Api = Pick<ApiClient, "listWorkspaces"> & NetworkApi;

const EXAMPLE_RULES: NetworkRule[] = [
  { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] },
];

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
  const [manageAll, setManageAll] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [publications, setPublications] = useState<NetworkPublication[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await api.listNetworkProfiles();
      setProfiles(list.profiles);
      setManageAll(list.manageAll === true);
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
      {manageAll ? <Overlaps api={api} revision={profiles} /> : null}
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
              </span>{" "}
              <span className="network-scope">
                {profile.ownerUserId ? t("network.scopeOwner") : t("network.scopeAll")}
              </span>
              {profile.description ? <p>{profile.description}</p> : null}
              <ul>
                {profile.rules.map((rule) => (
                  <li key={ruleSummary(rule)}>
                    <code>{ruleSummary(rule)}</code>
                  </li>
                ))}
              </ul>
              {profile.editable === false ? null : (
                <>
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
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <WorkspaceSelection api={api} extraProfiles={manageAll ? (profiles ?? []) : []} note={note} />
    </section>
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

/** A workspace picker over the shared panel; the root may select any profile. */
function WorkspaceSelection(props: {
  api: Api;
  extraProfiles: readonly NetworkProfile[];
  note?: string | undefined;
}) {
  const { api } = props;
  const t = useT();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.listWorkspaces().then(
      (list) => {
        setWorkspaces(list);
        setWorkspaceId((current) => current ?? list[0]?.id);
      },
      (err) => setError(errorMessage(err)),
    );
  }, [api]);

  if (workspaces.length === 0)
    return error ? <p role="alert">{error}</p> : <p>{t("network.noWorkspaces")}</p>;
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
      {workspaceId ? (
        <WorkspaceNetworkPanel
          api={api}
          workspaceId={workspaceId}
          extraProfiles={props.extraProfiles}
          note={props.note}
        />
      ) : null}
    </section>
  );
}

/**
 * Amendment 2 decision 15: LAN targets the host routes into a Docker bridge. Advisory; reread
 * whenever the profile list changes. A failed read shows nothing: the screen still works.
 */
function Overlaps({ api, revision }: { api: Api; revision: unknown }) {
  const t = useT();
  const [overlaps, setOverlaps] = useState<NetworkOverlap[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` triggers the reread.
  useEffect(() => {
    api.getNetworkOverlaps().then(
      (report) => setOverlaps(report.overlaps),
      () => setOverlaps([]),
    );
  }, [api, revision]);
  if (overlaps.length === 0) return null;
  return (
    <section className="network-overlaps" aria-live="polite">
      <h2>{t("network.overlaps.title")}</h2>
      <p>{t("network.overlaps.intro")}</p>
      <ul>
        {overlaps.map((o) => (
          <li key={`${o.source}:${o.label}:${o.cidr}:${o.network}:${o.networkCidr}`}>
            {t("network.overlaps.item", {
              cidr: o.cidr,
              label: o.label,
              network: o.network,
              networkCidr: o.networkCidr,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
