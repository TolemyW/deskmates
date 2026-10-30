import type { WorkspaceId } from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { navigate } from "../../router.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";

/** Resolve authorization before navigating, so a stale directory row cannot open the old team. */
export function useEnterWorkspace(api: ApiClient) {
  const scope = useWorkspaceScope(api);
  const t = useT();
  const [opening, setOpening] = useState<string>();
  const [error, setError] = useState<string>();
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const enter = async (id: WorkspaceId) => {
    if (pending.current) return;
    pending.current = true;
    setOpening(id);
    setError(undefined);
    try {
      const { workspace } = await api.getWorkspace(id);
      if (!active.current) return;
      if (workspace.archivedAt) {
        setError(t("workspaceManage.enterUnavailable"));
        return;
      }
      scope.add(workspace);
      navigate("#/threads");
    } catch (err) {
      if (active.current) setError(t("workspaceManage.enterFailed", { error: errorMessage(err) }));
    } finally {
      pending.current = false;
      if (active.current) setOpening(undefined);
    }
  };
  return { enter, opening, error };
}
