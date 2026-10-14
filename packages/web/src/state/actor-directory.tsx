import { type ReactNode, createContext, useEffect, useState } from "react";
import type { MembersClient } from "../api/members-client.js";
import { useWorkspaceForCalls } from "./workspace-scope.js";

export const ActorDirectoryContext = createContext<ReadonlyMap<string, string>>(new Map());
/**
 * The existing Admin/Owner directory is the only source. No profile lookup or new ACL. People
 * are listed per workspace (ADR-0022 amendment 6 W9), so it reads the selected workspace's.
 */
export function ActorDirectoryProvider({
  members,
  allowed,
  children,
}: {
  members: MembersClient;
  allowed: boolean;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<{
    client: MembersClient;
    names: ReadonlyMap<string, string>;
  }>();
  const { workspaceId, pending } = useWorkspaceForCalls();
  useEffect(() => {
    if (!allowed || pending) return;
    let live = true;
    let inFlight = false;
    let again = false;
    const refresh = async (): Promise<void> => {
      // Focus, online and the interval overlap; one request at a time plus one follow-up.
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        const rows = await members.listMembers(workspaceId);
        if (!live) return;
        // Removed/deleted people do not retain an old cached display name.
        const names = new Map(
          rows
            .filter((row) => row.status === "active" && row.displayName.trim())
            .map((row) => [`user:${row.userId}`, row.displayName]),
        );
        // The previous snapshot stays visible until this one replaces it: no flicker to raw IDs.
        setSnapshot({ client: members, names });
      } catch {
        /* Unknown is honest; do not retain stale names after access loss. */
        if (live) setSnapshot(undefined);
      } finally {
        inFlight = false;
      }
      if (live && again) {
        again = false;
        await refresh();
      }
    };
    void refresh();
    const onEvent = (): void => void refresh();
    window.addEventListener("focus", onEvent);
    window.addEventListener("online", onEvent);
    const timer = window.setInterval(onEvent, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", onEvent);
      window.removeEventListener("online", onEvent);
    };
  }, [members, allowed, workspaceId, pending]);
  const names =
    allowed && snapshot?.client === members ? snapshot.names : new Map<string, string>();
  return <ActorDirectoryContext.Provider value={names}>{children}</ActorDirectoryContext.Provider>;
}
