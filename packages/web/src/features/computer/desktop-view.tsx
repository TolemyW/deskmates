import type { BotId, ScreenAccess } from "@deskmates/contracts";
import { LoaderCircle, MonitorOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";

/**
 * Operator-only frames: never enter the agent ledger or turn a preview into a control session.
 * Every screen streams through the Gateway's proxy (`/api/desktop-stream`), which authenticates
 * to the workspace itself: the browser never holds a VNC password (ADR-0022 amendment 1, C7).
 * `open` fetches the ticket; by default it is the bot's own desktop.
 */
export function DesktopView({
  api,
  botId,
  open,
  mode = "view",
  preview = false,
  label,
}: {
  api: ApiClient;
  botId?: BotId;
  open?: () => Promise<ScreenAccess>;
  mode?: "view" | "control";
  preview?: boolean;
  label?: string;
}) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = (intersecting: boolean) =>
      setVisible(intersecting && document.visibilityState !== "hidden");
    let intersecting = true;
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            intersecting = entries[0]?.isIntersecting ?? false;
            update(intersecting);
          });
    observer?.observe(element);
    update(true);
    const change = () => update(intersecting);
    document.addEventListener("visibilitychange", change);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", change);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries a disconnected transport.
  useEffect(() => {
    if (!visible || !container.current) return;
    const target = container.current;
    let cancelled = false;
    let access: ScreenAccess | undefined;
    let rfb: { disconnect(): void } | undefined;
    setState("connecting");
    setError("");
    void (async () => {
      try {
        if (open) access = await open();
        else if (botId !== undefined) access = await api.screenAccess(botId, mode);
        else throw new Error("no screen to open");
        if (cancelled) {
          void api.closeScreenAccess(access.accessId).catch(() => {});
          return;
        }
        const { default: RFB } = await import("@novnc/novnc");
        if (cancelled) {
          void api.closeScreenAccess(access.accessId).catch(() => {});
          return;
        }
        const url = new URL(access.path, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const client = new RFB(target, url.href, { wsProtocols: [access.protocol] });
        client.viewOnly = mode === "view";
        client.scaleViewport = true;
        client.resizeSession = false;
        client.background = "#eef1f7";
        rfb = client;
        client.addEventListener("connect", () => {
          if (!cancelled) setState("live");
        });
        client.addEventListener("disconnect", () => {
          if (!cancelled) {
            setState("error");
            setError(currentI18n().t("desktopView.disconnected"));
          }
        });
        client.addEventListener("securityfailure", () => {
          if (!cancelled) {
            setState("error");
            setError(currentI18n().t("desktopView.authFailed"));
          }
        });
      } catch (err) {
        if (!cancelled) {
          setState("error");
          setError(errorMessage(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      rfb?.disconnect();
      if (access) void api.closeScreenAccess(access.accessId).catch(() => {});
      target.replaceChildren();
    };
  }, [api, botId, open, mode, visible, revision]);
  return (
    <div className={`desktop-frame ${preview ? "preview" : "expanded"}`}>
      <div
        ref={container}
        className="rfb-surface"
        aria-label={
          label ?? (mode === "view" ? t("desktopView.label.view") : t("desktopView.label.control"))
        }
      />
      {state !== "live" ? (
        <div className="desktop-overlay">
          {state === "connecting" ? (
            <>
              <LoaderCircle size={21} className="animate-spin" />
              <span>{t("desktopView.connecting")}</span>
            </>
          ) : (
            <>
              <MonitorOff size={23} />
              <span>{error}</span>
              <Button size="sm" variant="ghost" onClick={() => setRevision((r) => r + 1)}>
                <RefreshCw size={13} />
                {t("desktopView.reconnect")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <span className="desktop-live">
          <span className="status-dot" />
          {mode === "view" ? t("desktopView.live.view") : t("desktopView.live.control")}
        </span>
      )}
    </div>
  );
}
