import type { BotDefinition, Workspace } from "@deskmates/contracts";
import { Monitor, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button, ButtonLink } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { DesktopRail } from "../computer/desktop-rail.js";

export function DesktopsScreen({ api }: { api: ApiClient }) {
  const t = useT();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the status request.
  useEffect(() => {
    let active = true;
    void Promise.all([api.listWorkspaces(), api.listBots()])
      .then(([w, b]) => {
        if (active) {
          setWorkspaces(w);
          setBots(b);
          setError("");
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (active) {
          setError(errorMessage(err));
          setLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [api, revision]);
  return (
    <section className="desktops-screen page-container">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{t("desktops.eyebrow")}</span>
          <h1>{t("desktops.title")}</h1>
          <p>{t("desktops.intro")}</p>
        </div>
        <Button onClick={() => setRevision((r) => r + 1)}>
          <RefreshCw size={15} />
          {t("desktops.refresh")}
        </Button>
      </header>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {!loaded ? (
        <p className="muted">{t("desktops.loading")}</p>
      ) : bots.length === 0 ? (
        <div className="desktops-empty">
          <Monitor size={40} />
          <h2>{t("desktops.empty.title")}</h2>
          <p>{t("desktops.empty.body")}</p>
          <ButtonLink href="#/manage">{t("desktops.empty.setup")}</ButtonLink>
        </div>
      ) : (
        workspaces
          .filter((w) => bots.some((b) => b.workspaceId === w.id))
          .map((w) => (
            <section key={w.id} className="workspace-desktops">
              <h2>{w.name}</h2>
              <DesktopRail
                api={api}
                workspaceId={w.id}
                members={bots
                  .filter((b) => b.workspaceId === w.id)
                  .map((b) => ({ botId: b.id, name: b.name }))}
              />
            </section>
          ))
      )}
    </section>
  );
}
