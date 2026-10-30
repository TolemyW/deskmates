// Network profiles (ADR-0027 amendment 1, decisions 12 and 13 owner-decided 2026-10-14): the
// administrator account and workspace Owners define named LAN grants; a workspace's Admins select
// them. The screen leads with the workspace at hand (what it can reach, what it may select), then
// lists every profile the caller may see in one table, with the editor above it when one is open.
// Authorization is the Gateway's: a refused call shows its message.

import type {
  NetworkOverlap,
  NetworkProfile,
  NetworkPublication,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import {
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deskmates/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useWorkspaceForCalls } from "../../state/workspace-scope.js";
import type { NetworkApi } from "./api.js";
import { HostResourcesSection } from "./host-resources-section.js";
import { Expiry, Publications, isExpired, ruleSummary } from "./network-format.js";
import { type ProfileDraft, ProfileForm, type ProfileInput, draftOf } from "./profile-form.js";
import { WorkspaceNetworkPanel } from "./workspace-network-panel.js";

export { ruleSummary } from "./network-format.js";

type Api = Pick<ApiClient, "listWorkspaces"> & NetworkApi;

export function NetworkScreen({ api }: { api: Api }) {
  const t = useT();
  const [profiles, setProfiles] = useState<NetworkProfile[]>();
  const [manageAll, setManageAll] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<ProfileDraft>();
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(false);
  const editing = draft !== undefined;
  useEffect(() => {
    if (wasEditing.current && !editing) editorTrigger.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const openEditor = (trigger: HTMLButtonElement, profile?: NetworkProfile) => {
    editorTrigger.current = trigger;
    setError(undefined);
    setDraft(draftOf(profile));
  };
  const [publications, setPublications] = useState<NetworkPublication[]>([]);
  const [busy, setBusy] = useState(false);
  const [overlaps, setOverlaps] = useState<NetworkOverlap[]>([]);

  const reload = useCallback(async () => {
    setError(undefined);
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

  // Amendment 2 decision 15: LAN targets the host routes into a Docker bridge. Advisory, root
  // only, reread whenever the profile list changes; a failed read shows nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `profiles` is the trigger to reread.
  useEffect(() => {
    if (!manageAll) return;
    let active = true;
    api.getNetworkOverlaps().then(
      (report) => {
        if (active) setOverlaps(report.overlaps);
      },
      () => {
        if (active) setOverlaps([]);
      },
    );
    return () => {
      active = false;
    };
  }, [api, manageAll, profiles]);

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

  const save = (d: ProfileDraft, input: ProfileInput) =>
    run(async () => {
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

  const overlapping = new Set(overlaps.filter((o) => o.source === "profile").map((o) => o.label));

  return (
    <section className="workspace-screen resource-page page-container network-page">
      <PageHeader
        title={t("network.title")}
        description={t("network.intro")}
        action={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => void reload()}>
              {t("network.refresh")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || draft !== undefined}
              onClick={(event) => openEditor(event.currentTarget)}
            >
              {t("network.new")}
            </Button>
          </>
        }
      />
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <Publications publications={publications} />
      {draft ? (
        <ProfileForm
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSave={(input) => void save(draft, input)}
          onCancel={() => {
            setDraft(undefined);
            setError(undefined);
          }}
        />
      ) : null}
      <WorkspaceBlock api={api} extraProfiles={manageAll ? (profiles ?? []) : []} note={note} />
      {overlaps.length > 0 ? (
        <details className="network-overlaps">
          <summary>{t("network.overlaps.summary", { count: overlaps.length })}</summary>
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
        </details>
      ) : null}
      <section className="card network-all" aria-labelledby="network-all-title">
        <h2 id="network-all-title">{t("network.allProfiles")}</h2>
        {profiles === undefined ? (
          error ? null : (
            <p className="muted">{t("network.loading")}</p>
          )
        ) : profiles.length === 0 ? (
          <p className="muted">{t("network.empty")}</p>
        ) : (
          <Table className="network-table" aria-label={t("network.allProfiles")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("network.col.name")}</TableHead>
                <TableHead>{t("network.col.targets")}</TableHead>
                <TableHead>{t("network.col.expires")}</TableHead>
                <TableHead>{t("network.col.scope")}</TableHead>
                <TableHead>{t("network.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => (
                <TableRow key={profile.id} data-expired={isExpired(profile.expiresAt)}>
                  <TableCell>
                    <strong>{profile.name}</strong>
                    {overlapping.has(profile.name) ? (
                      <span className="network-warn" title={t("network.overlaps.badge")}>
                        {t("network.overlaps.badgeShort")}
                      </span>
                    ) : null}
                    {profile.description ? (
                      <p className="muted small">{profile.description}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <ul className="network-rule-list">
                      {profile.rules.map((rule) => (
                        <li key={ruleSummary(rule)}>
                          <code>{ruleSummary(rule)}</code>
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell>
                    <Expiry expiresAt={profile.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <span className="network-scope">
                      {profile.ownerUserId ? t("network.scopeOwner") : t("network.scopeAll")}
                    </span>
                  </TableCell>
                  <TableCell>
                    {profile.editable === false ? null : (
                      <span className="network-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || editing}
                          onClick={(event) => openEditor(event.currentTarget, profile)}
                        >
                          {t("network.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || editing}
                          onClick={() => remove(profile)}
                        >
                          {t("network.delete")}
                        </Button>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      {manageAll ? <HostResourcesSection api={api} /> : null}
    </section>
  );
}

/**
 * The workspace at hand: the one selected in the sidebar, else the first the caller has; a
 * picker appears only when there is more than one to choose from.
 */
function WorkspaceBlock(props: {
  api: Api;
  extraProfiles: readonly NetworkProfile[];
  note?: string | undefined;
}) {
  const { api } = props;
  const t = useT();
  const scope = useWorkspaceForCalls();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [picked, setPicked] = useState<WorkspaceId>();
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRevision requests a local retry.
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setError(undefined);
    api.listWorkspaces().then(
      (list) => {
        if (active) {
          setWorkspaces(list);
          setLoaded(true);
        }
      },
      (err) => {
        if (active) {
          setError(errorMessage(err));
          setLoaded(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api, loadRevision]);

  const workspaceId = picked ?? scope.workspaceId ?? workspaces[0]?.id;
  const current = workspaces.find((w) => w.id === workspaceId);
  if (error)
    return (
      <div role="alert">
        {error}{" "}
        <Button
          type="button"
          variant="outline"
          onClick={() => setLoadRevision((value) => value + 1)}
        >
          {t("network.refresh")}
        </Button>
      </div>
    );
  if (!loaded) return <output>{t("network.loading")}</output>;
  if (workspaces.length === 0 || workspaceId === undefined)
    return <p className="muted">{t("network.noWorkspaces")}</p>;
  return (
    <section className="card network-workspace" aria-labelledby="network-workspace-title">
      <div className="network-workspace-head">
        <h2 id="network-workspace-title">
          {t("network.thisWorkspace", { workspace: current?.name ?? workspaceId })}
        </h2>
        {workspaces.length > 1 ? (
          <label className="network-picker">
            {t("network.workspacePicker")}
            <select value={workspaceId} onChange={(e) => setPicked(e.target.value as WorkspaceId)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <WorkspaceNetworkPanel
        api={api}
        workspaceId={workspaceId}
        extraProfiles={props.extraProfiles}
        note={props.note}
      />
    </section>
  );
}
