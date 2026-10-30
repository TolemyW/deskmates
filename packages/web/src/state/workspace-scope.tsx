// The current workspace, the one context the whole UI sits inside. A workspace is a team of
// bots on one shared computer: its bots are the Contacts, its threads are the Chats, and its
// computer is the page of the same name. The operator picks one in the sidebar switcher; most
// deployments have exactly one, so the switcher then shows only the name. The choice is kept per
// browser so a reload lands where the operator was.

import type { Workspace, WorkspaceId } from "@deskmates/contracts";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ApiClient } from "../api/client.js";
import { subscribeEvents } from "../api/events.js";
import { errorMessage } from "../format.js";
import { BotAvatarsProvider } from "./bot-avatars.js";

export interface WorkspaceScope {
  workspaces: readonly Workspace[];
  /** The selected workspace; undefined until the list loads or when there is none yet. */
  current: Workspace | undefined;
  loaded: boolean;
  error: string | undefined;
  /** Re-read authorized workspaces after a failed load, without replacing the session. */
  reload: () => Promise<void>;
  select: (id: WorkspaceId) => void;
  /** Registers a workspace created elsewhere (first-run form) and selects it. */
  add: (workspace: Workspace) => void;
  update: (workspace: Workspace) => void;
  /** Opens the new-workspace dialog the provider renders. */
  openCreate: () => void;
  /**
   * The paged, authorized directory (ADR-0034). `workspaces` above is the shell's name map; a
   * screen that lists workspaces for people to browse reads the directory instead.
   */
  directory?: Pick<ApiClient, "listWorkspaceDirectory">;
}

/** What the provider hands the new-workspace dialog the shell renders for it. */
export interface NewWorkspaceDialogControls {
  open: boolean;
  onReturnFocus?: () => void;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
}

const STORAGE_KEY = "deskmates.workspace";

function loadSelection(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveSelection(id: string | undefined): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A browser without storage still keeps the choice for this page load.
  }
}

const WorkspaceScopeContext = createContext<WorkspaceScope | undefined>(undefined);

/** Failed reads are not evidence of an empty tenant. Keep the last successful list. */
function useWorkspaceList(api: ApiClient, enabled = true) {
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const revision = useRef(0);
  const pendingChanges = useRef<Map<WorkspaceId, Workspace> | undefined>(undefined);
  const upsertWorkspace = useCallback((workspace: Workspace) => {
    // A mutation/event observed after a snapshot began is newer than that snapshot.
    pendingChanges.current?.set(workspace.id, workspace);
    setWorkspaces((items) =>
      workspace.archivedAt
        ? items.filter((item) => item.id !== workspace.id)
        : items.some((item) => item.id === workspace.id)
          ? items.map((item) => (item.id === workspace.id ? workspace : item))
          : [...items, workspace],
    );
  }, []);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const request = ++revision.current;
    const changes = new Map<WorkspaceId, Workspace>();
    pendingChanges.current = changes;
    try {
      const list = await api.listWorkspaces();
      if (request !== revision.current) return;
      const merged = new Map(list.map((workspace) => [workspace.id, workspace]));
      for (const [id, workspace] of changes) merged.set(id, workspace);
      setWorkspaces([...merged.values()].filter((workspace) => !workspace.archivedAt));
      setLoaded(true);
      setError(undefined);
    } catch (err) {
      if (request === revision.current) setError(errorMessage(err));
    } finally {
      if (request === revision.current) pendingChanges.current = undefined;
    }
  }, [api, enabled]);
  useEffect(() => {
    if (!enabled) return;
    setWorkspaces([]);
    setLoaded(false);
    setError(undefined);
    void reload();
    const online = () => void reload();
    window.addEventListener("online", online);
    return () => {
      revision.current += 1;
      pendingChanges.current = undefined;
      window.removeEventListener("online", online);
    };
  }, [reload, enabled]);
  return { workspaces, upsertWorkspace, loaded, error, reload };
}

export function WorkspaceScopeProvider({
  api,
  initialWorkspaceId,
  newWorkspaceDialog,
  children,
}: {
  api: ApiClient;
  /** Test hook: the workspace to select once the list loads, instead of the stored one. */
  initialWorkspaceId?: WorkspaceId | undefined;
  /**
   * The dialog `openCreate` opens. The workspaces feature owns it and the shell passes it in,
   * so this shared state imports no feature; without it `openCreate` shows nothing.
   */
  newWorkspaceDialog?: (controls: NewWorkspaceDialogControls) => ReactNode;
  children: ReactNode;
}) {
  const { workspaces, upsertWorkspace, loaded, error, reload } = useWorkspaceList(api);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => initialWorkspaceId ?? loadSelection(),
  );
  const selectedRef = useRef(selectedId);
  const selectionRequest = useRef(0);
  const selecting = useRef<WorkspaceId | undefined>(undefined);
  const [selectionError, setSelectionError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const createOpener = useRef<HTMLElement | null>(null);

  useEffect(
    () => () => {
      selectionRequest.current += 1;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    // The row follows the live stream: an allowlist edit in another tab, or a site allowed from
    // a chat (ADR-0020), shows on the settings page without a reload.
    const stop = globalThis.EventSource
      ? subscribeEvents({
          onReconnect: () => void reload(),
          onEvent: (event) => {
            if (!active || event.type !== "workspace") return;
            upsertWorkspace(event.workspace);
          },
        })
      : () => {};
    return () => {
      active = false;
      stop();
    };
  }, [reload, upsertWorkspace]);

  // Normalize archived/stale selections, including an empty list. A selection made by a child
  // effect wins over this render's fallback (for example add() while a snapshot is settling).
  const current = workspaces.find((w) => w.id === selectedId) ?? workspaces[0];
  useEffect(() => {
    if (loaded && selectedId !== current?.id && selectedRef.current === selectedId) {
      selectedRef.current = current?.id;
      setSelectedId(current?.id);
      saveSelection(current?.id);
    }
  }, [loaded, selectedId, current?.id]);

  const commitSelection = useCallback((id: WorkspaceId) => {
    selectedRef.current = id;
    setSelectedId(id);
    saveSelection(id);
  }, []);
  const select = useCallback(
    (id: WorkspaceId) => {
      setSelectionError(undefined);
      if (workspaces.some((workspace) => workspace.id === id)) {
        selectionRequest.current += 1;
        selecting.current = undefined;
        commitSelection(id);
        return;
      }
      if (selecting.current === id) return;
      // Directory rows can be newer than the shell's initial name map (another tab/API create).
      // Resolve the authorized full row before selecting; never fall back to the old workspace.
      selecting.current = id;
      const request = ++selectionRequest.current;
      void api
        .getWorkspace(id)
        .then(({ workspace }) => {
          if (request !== selectionRequest.current) return;
          upsertWorkspace(workspace);
          commitSelection(workspace.id);
        })
        .catch((err: unknown) => {
          if (request === selectionRequest.current) setSelectionError(errorMessage(err));
        })
        .finally(() => {
          if (request === selectionRequest.current) selecting.current = undefined;
        });
    },
    [api, workspaces, commitSelection, upsertWorkspace],
  );
  const add = useCallback(
    (workspace: Workspace) => {
      selectionRequest.current += 1;
      selecting.current = undefined;
      setSelectionError(undefined);
      upsertWorkspace(workspace);
      commitSelection(workspace.id);
    },
    [commitSelection, upsertWorkspace],
  );
  const update = useCallback(
    (workspace: Workspace) => {
      upsertWorkspace(workspace);
    },
    [upsertWorkspace],
  );
  const openCreate = useCallback(() => {
    createOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCreating(true);
  }, []);

  const value = useMemo<WorkspaceScope>(
    () => ({
      workspaces,
      current,
      loaded,
      error: selectionError ?? error,
      reload,
      select,
      add,
      update,
      openCreate,
      directory: api,
    }),
    [
      workspaces,
      current,
      loaded,
      error,
      selectionError,
      reload,
      select,
      add,
      update,
      openCreate,
      api,
    ],
  );

  return (
    <WorkspaceScopeContext.Provider value={value}>
      <BotAvatarsProvider>{children}</BotAvatarsProvider>
      {newWorkspaceDialog?.({
        open: creating,
        onReturnFocus: () => {
          if (createOpener.current?.isConnected) createOpener.current.focus();
        },
        onClose: () => setCreating(false),
        onCreated: (created) => {
          setCreating(false);
          add(created);
        },
      })}
    </WorkspaceScopeContext.Provider>
  );
}

/**
 * The scope from the nearest provider. A screen rendered without one (tests, embedding) gets a
 * self-contained scope that loads the workspace list itself and selects the first entry, so the
 * screen behaves the same way as under the app shell.
 */
export function useWorkspaceScope(api: ApiClient): WorkspaceScope {
  const fromContext = useContext(WorkspaceScopeContext);
  const standalone = fromContext === undefined;
  const { workspaces, upsertWorkspace, loaded, error, reload } = useWorkspaceList(api, standalone);
  const [selectedId, setSelectedId] = useState<string>();

  const select = useCallback((id: WorkspaceId) => setSelectedId(id), []);
  const add = useCallback(
    (workspace: Workspace) => {
      upsertWorkspace(workspace);
      setSelectedId(workspace.id);
    },
    [upsertWorkspace],
  );
  const update = useCallback(
    (workspace: Workspace) => {
      upsertWorkspace(workspace);
    },
    [upsertWorkspace],
  );
  const openCreate = useCallback(() => {}, []);
  const current = workspaces.find((w) => w.id === selectedId) ?? workspaces[0];
  const local = useMemo<WorkspaceScope>(
    () => ({
      workspaces,
      current,
      loaded,
      error,
      reload,
      select,
      add,
      update,
      openCreate,
      directory: api,
    }),
    [workspaces, current, loaded, error, reload, select, add, update, openCreate, api],
  );
  return fromContext ?? local;
}

/**
 * The selected workspace's id from the nearest provider, without loading anything; undefined
 * outside a provider or before the list loads. Role checks ask with it (ADR-0022 amendment 6).
 */
export function useSelectedWorkspaceId(): WorkspaceId | undefined {
  return useContext(WorkspaceScopeContext)?.current?.id;
}

/**
 * The nearest provider's scope, without loading anything; undefined outside a provider. A
 * per-workspace call waits while it is still undefined in a provider (ADR-0022 amendment 6 W9).
 */
export function useOptionalWorkspaceScope(): WorkspaceScope | undefined {
  return useContext(WorkspaceScopeContext);
}

/**
 * The workspace a per-workspace call names: the selected one under a provider, `pending` while
 * that provider is still loading the list, and undefined outside a provider or with no workspace
 * (the Gateway then acts on the tenant's only workspace).
 */
export function useWorkspaceForCalls(): { workspaceId: WorkspaceId | undefined; pending: boolean } {
  const scope = useContext(WorkspaceScopeContext);
  return {
    workspaceId: scope?.current?.id,
    pending: scope !== undefined && !scope.current && !scope.loaded,
  };
}
