import type { BotId, BotScreen, WorkspaceId } from "@deskmates/contracts";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { DesktopMember } from "./desktop-rail.js";
import { DesktopView } from "./desktop-view.js";

/** Select a view of the shared computer; the control lease always covers the workspace. */
export function TakeoverDisplay({
  api,
  workspaceId,
  members,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  members: readonly DesktopMember[];
}) {
  const t = useT();
  const [selected, setSelected] = useState<BotId | "workspace">(members[0]?.botId ?? "workspace");
  const target = members.some((member) => member.botId === selected) ? selected : "workspace";
  const [screen, setScreen] = useState<BotScreen>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the status request.
  useEffect(() => {
    if (target === "workspace") return;
    let active = true;
    setScreen(undefined);
    setError("");
    void api.getBotScreen(target).then(
      (next) => {
        if (active) setScreen(next);
      },
      (err: unknown) => {
        if (active) setError(errorMessage(err));
      },
    );
    return () => {
      active = false;
    };
  }, [api, target, revision]);
  const current = screen?.botId === target ? screen : undefined;
  const shared = target === "workspace" || (current !== undefined && current.state !== "ready");
  const open = useCallback(
    () =>
      shared || target === "workspace"
        ? api.openTakeoverScreen(workspaceId)
        : api.screenAccess(target, "control"),
    [api, workspaceId, target, shared],
  );
  return (
    <>
      <label className="desktop-screen-picker">
        <span>{t("desktopView.screen")}</span>
        <select
          value={target}
          onChange={(event) => setSelected(event.target.value as BotId | "workspace")}
        >
          {members.map((member) => (
            <option key={member.botId} value={member.botId}>
              {member.name}
            </option>
          ))}
          <option value="workspace">{t("desktopView.workspace")}</option>
        </select>
      </label>
      {shared && target !== "workspace" ? (
        <p className="desktop-control-note">{t("desktopView.sharedFallback")}</p>
      ) : null}
      {shared || current ? (
        <DesktopView
          key={shared ? "workspace" : target}
          api={api}
          open={open}
          mode="control"
          shared={shared}
          label={shared ? t("desktopView.workspace") : t("desktopView.label.control")}
        />
      ) : error ? (
        <div role="alert" className="desktop-target-status">
          {error}
          <Button onClick={() => setRevision((value) => value + 1)}>
            {t("desktopRail.retry")}
          </Button>
        </div>
      ) : (
        <output className="desktop-target-status">{t("desktopView.connecting")}</output>
      )}
    </>
  );
}
