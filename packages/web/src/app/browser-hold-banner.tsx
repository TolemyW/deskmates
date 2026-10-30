// The workspace-wide takeover notice (issue #17). It stays above every feature screen while a
// human owns the shared browser. The holder and an Owner/Admin may release it; a Member who is
// not the holder and a Guest can see why bots are waiting but cannot end somebody else's lease.

import type { WorkspaceId } from "@deskmates/contracts";
import type { ApiClient } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { useWorkspaceLock } from "../features/chats/use-workspace-lock.js";
import { useT } from "../i18n/i18n-provider.js";
import { useWorkspaceRole } from "../state/session-roles.js";

export function BrowserHoldBanner({
  api,
  workspaceId,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId | undefined;
}) {
  const t = useT();
  const browser = useWorkspaceLock(workspaceId, api);
  const role = useWorkspaceRole(workspaceId);
  const mayRelease =
    role !== "guest" &&
    (browser.heldByMe || role === "owner" || role === "admin" || role === undefined);
  if (!browser.loaded || !browser.held) return null;
  return (
    <output className="browser-hold-banner">
      <span>{t("app.browserHold.held")}</span>
      {mayRelease ? (
        <Button size="sm" type="button" disabled={browser.busy} onClick={browser.handBack}>
          {t("app.browserHold.release")}
        </Button>
      ) : null}
      {browser.error ? <span className="error">{browser.error}</span> : null}
    </output>
  );
}
