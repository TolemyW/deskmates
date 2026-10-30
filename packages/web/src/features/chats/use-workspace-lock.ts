// Human takeover of the workspace browser, for whichever screen shows a thread (ADR-0004,
// design v0.3 §3.3). One workspace is one Chromium and one screen, so the hold is exclusive for
// the whole group: while a human has it, every bot's browser tool returns a wait message.
//
// The hook owns three things: the fetch of `GET /api/workspaces/:id`, a second, unfiltered SSE
// subscription (the `workspace_lock` frame carries no `threadId`, so the thread-filtered stream
// never delivers it), and the actions. The subscription outlives the workspace id it filters
// on, so it reads the id from a ref and opens once per mount.
//
// The screen itself is never an address: taking over grants a lease, and the holder's screen
// streams through the Gateway's screen proxy with a one-use region or overview ticket, which
// ends when the lease does (ADR-0022 amendment 1, C7). `screenOpen` says whether to show it.

import type { BrowserLock, WorkspaceContainerState, WorkspaceId } from "@deskmates/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { errorMessage } from "../../format.js";

export interface WorkspaceLockState {
  /** The human hold, or `null` when the browser is free. The Gateway never reports a run's tab. */
  lock: BrowserLock | null;
  /** False until the workspace container exists and publishes the shared screen. */
  hasScreen: boolean;
  /**
   * Whether the workspace container exists, from the same fetch (issue #15); undefined until it
   * settles and from an older Gateway. The composer says what a first message will do.
   */
  container: WorkspaceContainerState | undefined;
  /** Whether the held screen is shown; it closes when the hold ends. */
  screenOpen: boolean;
  held: boolean;
  /** True only when this signed-in principal owns the current human hold. */
  heldByMe: boolean;
  /** False until `GET /api/workspaces/:id` has settled; the controls stay hidden until then. */
  loaded: boolean;
  /** An action is in flight; the buttons stay disabled so a double click cannot double post. */
  busy: boolean;
  error: string | undefined;
  takeOver: () => void;
  /** Show the screen of a hold that already exists after a reload. */
  openScreen: () => void;
  /** Closing control hands the browser back; the dialog never leaves a hidden hold behind. */
  closeScreen: () => void;
  handBack: () => void;
}

export function useWorkspaceLock(
  workspaceId: WorkspaceId | undefined,
  api: ApiClient,
): WorkspaceLockState {
  const [lock, setLock] = useState<BrowserLock | null>(null);
  const [hasScreen, setHasScreen] = useState(false);
  const [container, setContainer] = useState<WorkspaceContainerState>();
  const [screenOpen, setScreenOpen] = useState(false);
  const screenOpenRef = useRef(false);
  const [heldByMe, setHeldByMe] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const lockRef = useRef<BrowserLock | null>(null);
  const lockRevision = useRef(0);
  const fetchRevision = useRef(0);
  const actionRevision = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback(
    (id: WorkspaceId): void => {
      const requestRevision = ++fetchRevision.current;
      const lockRevisionAtStart = lockRevision.current;
      api
        .getWorkspace(id)
        .then((view) => {
          if (
            !mounted.current ||
            workspaceRef.current !== id ||
            requestRevision !== fetchRevision.current
          )
            return;
          // A workspace_lock frame or local action that happened after this request is newer than
          // its snapshot. Whether the screen exists is safe to refresh independently.
          if (lockRevision.current === lockRevisionAtStart) {
            lockRef.current = view.browserLock;
            setLock(view.browserLock);
            setHeldByMe(view.browserLockHeldByMe === true);
            if (view.browserLock === null) {
              screenOpenRef.current = false;
              setScreenOpen(false);
            }
          }
          setHasScreen(view.takeoverScreen);
          setContainer(view.container);
          setError(undefined);
        })
        .catch((err: unknown) => {
          if (
            mounted.current &&
            workspaceRef.current === id &&
            requestRevision === fetchRevision.current
          ) {
            setError(errorMessage(err));
          }
        })
        .finally(() => {
          if (
            mounted.current &&
            workspaceRef.current === id &&
            requestRevision === fetchRevision.current
          ) {
            setLoaded(true);
          }
        });
    },
    [api],
  );

  useEffect(() => {
    fetchRevision.current += 1;
    lockRevision.current += 1;
    actionRevision.current += 1;
    lockRef.current = null;
    setLock(null);
    setHasScreen(false);
    setContainer(undefined);
    setScreenOpen(false);
    screenOpenRef.current = false;
    setHeldByMe(false);
    setLoaded(false);
    setError(undefined);
    if (workspaceId !== undefined) refetch(workspaceId);
  }, [workspaceId, refetch]);

  useEffect(() => {
    // Unfiltered: `workspace_lock` has no `threadId`, so `/api/events?threadId=` drops it. Two
    // operator tabs therefore agree on who holds the browser without either one refetching.
    const stop = subscribeEvents({
      onEvent: (event) => {
        if (event.type !== "workspace_lock") return;
        if (event.workspaceId !== workspaceRef.current) return;
        lockRevision.current += 1;
        lockRef.current = event.browserLock;
        setLock(event.browserLock);
        if (event.browserLock === null) setHeldByMe(false);
        else {
          // The frame intentionally carries no principal. Refresh the identity-bound boolean so
          // a persistent global banner learns that this tab's person is the holder after another
          // hook (for example ChatPane) took the lease.
          setHeldByMe(false);
          const id = workspaceRef.current;
          if (id !== undefined) refetch(id);
        }
        // The Gateway has already closed the proxied stream; drop the view with it.
        if (event.browserLock === null) {
          screenOpenRef.current = false;
          setScreenOpen(false);
        }
      },
      onReconnect: () => {
        const id = workspaceRef.current;
        if (id !== undefined) refetch(id);
      },
    });
    return stop;
  }, [refetch]);

  const takeOver = useCallback(() => {
    if (workspaceId === undefined || !hasScreen) return;
    const action = ++actionRevision.current;
    const lockRevisionAtStart = lockRevision.current;
    setBusy(true);
    setError(undefined);
    api
      .takeOver(workspaceId)
      .then((result) => {
        if (
          !mounted.current ||
          action !== actionRevision.current ||
          workspaceRef.current !== workspaceId ||
          (lockRevision.current !== lockRevisionAtStart && lockRef.current === null)
        )
          return;
        if (lockRevision.current === lockRevisionAtStart) lockRevision.current += 1;
        lockRef.current = result.lock;
        setLock(result.lock);
        setHeldByMe(true);
        // The lease is granted; the screen opens through the proxy.
        screenOpenRef.current = true;
        setScreenOpen(true);
      })
      .catch((err: unknown) => {
        if (mounted.current && action === actionRevision.current) setError(errorMessage(err));
      })
      .finally(() => {
        if (mounted.current && action === actionRevision.current) setBusy(false);
      });
  }, [workspaceId, hasScreen, api]);

  const openScreen = useCallback(() => {
    if (lockRef.current !== null) {
      screenOpenRef.current = true;
      setScreenOpen(true);
    }
  }, []);

  const handBack = useCallback(() => {
    if (workspaceId === undefined) return;
    const action = ++actionRevision.current;
    const lockRevisionAtStart = lockRevision.current;
    setBusy(true);
    setError(undefined);
    api
      .handBack(workspaceId)
      .then(() => {
        if (
          !mounted.current ||
          action !== actionRevision.current ||
          workspaceRef.current !== workspaceId ||
          (lockRevision.current !== lockRevisionAtStart && lockRef.current !== null)
        )
          return;
        lockRevision.current += 1;
        lockRef.current = null;
        setLock(null);
        setHeldByMe(false);
        screenOpenRef.current = false;
        setScreenOpen(false);
      })
      .catch((err: unknown) => {
        if (mounted.current && action === actionRevision.current) setError(errorMessage(err));
      })
      .finally(() => {
        if (mounted.current && action === actionRevision.current) setBusy(false);
      });
  }, [workspaceId, api]);

  const closeScreen = handBack;

  // A route change or parent unmount cannot strand a control session. Handback is idempotent;
  // the normal close path may race this cleanup safely.
  useEffect(
    () => () => {
      const id = workspaceRef.current;
      if (id !== undefined && screenOpenRef.current) {
        // Navigation is already committed, so there is nowhere useful to surface a cleanup
        // failure. The global hold banner still exposes the lease if the Gateway remains
        // reachable and the release did not take effect.
        void api.handBack(id).catch(() => undefined);
      }
    },
    [api],
  );

  return {
    lock,
    hasScreen,
    container,
    screenOpen: screenOpen && lock !== null,
    held: lock !== null,
    heldByMe,
    loaded,
    busy,
    error,
    takeOver,
    openScreen,
    closeScreen,
    handBack,
  };
}
