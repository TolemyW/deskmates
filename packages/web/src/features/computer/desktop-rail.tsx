import type { BotId, BotScreen, WorkspaceId } from "@deskmates/contracts";
import { ArrowUpRight, Monitor, MousePointer2, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { DesktopView } from "./desktop-view.js";

export interface DesktopMember {
  botId: BotId;
  name: string;
}
export function DesktopRail({
  api,
  members,
  workspaceId,
}: { api: ApiClient; members: readonly DesktopMember[]; workspaceId: WorkspaceId }) {
  const t = useT();
  return (
    <section className="desktop-rail" aria-label={t("desktopRail.label")}>
      <header>
        <div>
          <span className="eyebrow">{t("desktopRail.eyebrow")}</span>
          <h2>
            <Monitor size={17} /> {t("desktopRail.title")}
          </h2>
        </div>
        <span className="desktop-count">{members.length}</span>
      </header>
      <p className="desktop-intro">{t("desktopRail.intro")}</p>
      <div className="desktop-cards">
        {members.map((member) => (
          <DesktopCard key={member.botId} api={api} member={member} workspaceId={workspaceId} />
        ))}
      </div>
      <div className="desktop-footnote">
        <ShieldCheck size={16} />
        <span>{t("desktopRail.footnote")}</span>
      </div>
    </section>
  );
}
export function DesktopCard({
  api,
  member,
  workspaceId,
}: { api: ApiClient; member: DesktopMember; workspaceId: WorkspaceId }) {
  const t = useT();
  const [screen, setScreen] = useState<BotScreen>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [control, setControl] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => {
    const next = await api.getBotScreen(member.botId);
    setScreen(next);
    if (!next.humanHeld) setControl(false);
  }, [api, member.botId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the status request.
  useEffect(() => {
    let active = true;
    const load = () => {
      void api
        .getBotScreen(member.botId)
        .then((next) => {
          if (active) {
            setScreen(next);
            setError("");
            if (!next.humanHeld) setControl(false);
          }
        })
        .catch((err) => {
          if (active) setError(errorMessage(err));
        });
    };
    load();
    const visibleLoad = () => {
      if (document.visibilityState !== "hidden") load();
    };
    const timer = window.setInterval(visibleLoad, 5000);
    window.addEventListener("focus", visibleLoad);
    document.addEventListener("visibilitychange", visibleLoad);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", visibleLoad);
      document.removeEventListener("visibilitychange", visibleLoad);
    };
  }, [api, member.botId, revision]);
  const enter = async () => {
    setBusy(true);
    setError("");
    try {
      if (screen?.state !== "ready") setScreen(await api.startBotScreen(member.botId));
      setOpen(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const take = async () => {
    setBusy(true);
    setError("");
    try {
      await api.takeOver(workspaceId);
      await refresh();
      setControl(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const handBack = async () => {
    setBusy(true);
    setError("");
    try {
      await api.handBack(workspaceId);
      setControl(false);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="desktop-card">
      <div className="desktop-card-heading">
        <Avatar name={member.name} className="bot-avatar" />
        <div>
          <h3>{member.name}</h3>
          <span>
            {screen?.humanHeld
              ? t("desktopRail.status.humanControl")
              : screen?.state === "ready"
                ? t("desktopRail.status.desktopAvailable")
                : screen?.state === "legacy"
                  ? t("desktopRail.status.legacy")
                  : t("desktopRail.status.notStarted")}
          </span>
        </div>
      </div>
      {screen?.state === "ready" ? (
        <DesktopView api={api} botId={member.botId} preview />
      ) : (
        <div className="desktop-placeholder">
          <Monitor size={29} />
          <span>
            {screen?.state === "legacy"
              ? t("desktopRail.placeholder.legacy")
              : t("desktopRail.placeholder.default")}
          </span>
        </div>
      )}
      <div className="desktop-card-actions">
        <span>{t("desktopRail.sharedLogin")}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void enter()}>
          {screen?.state === "ready" ? t("desktopRail.open") : t("desktopRail.start")}
          <ArrowUpRight size={14} />
        </Button>
      </div>
      {error ? (
        <output className="error desktop-error">
          {error}{" "}
          <Button size="sm" variant="ghost" onClick={() => setRevision((r) => r + 1)}>
            <RefreshCw size={12} />
            {t("desktopRail.retry")}
          </Button>
        </output>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (control) event.preventDefault();
          }}
        >
          <div className="desktop-dialog-heading">
            <Avatar name={member.name} className="bot-avatar" />
            <div>
              <DialogTitle className="text-lg font-semibold">
                {t("desktopRail.dialogTitle", { name: member.name })}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                {control
                  ? t("desktopRail.description.control")
                  : screen?.humanHeld
                    ? t("desktopRail.description.held")
                    : t("desktopRail.description.view")}
              </DialogDescription>
            </div>
          </div>
          <DesktopView
            key={control ? "control" : "view"}
            api={api}
            botId={member.botId}
            mode={control ? "control" : "view"}
          />
          <div className="desktop-dialog-footer">
            <span>
              <ShieldCheck size={15} />
              {t("desktopRail.footer")}
            </span>
            {screen?.humanHeld && !control ? (
              <Button disabled={busy} onClick={() => setControl(true)}>
                <MousePointer2 size={15} />
                {t("desktopRail.resume")}
              </Button>
            ) : null}
            {screen?.humanHeld ? (
              <Button disabled={busy} onClick={() => void handBack()}>
                <Play size={15} />
                {t("desktopRail.return")}
              </Button>
            ) : (
              <Button variant="default" disabled={busy} onClick={() => void take()}>
                <MousePointer2 size={15} />
                {t("desktopRail.take")}
              </Button>
            )}
          </div>
          <p className="desktop-control-note">{t("desktopRail.controlNote")}</p>
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </article>
  );
}
