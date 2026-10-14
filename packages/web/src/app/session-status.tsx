// What the page shows while it asks the Gateway about the session, or when it cannot reach it.

import { Button } from "../components/ui/button.js";
import { useT } from "../i18n/i18n-provider.js";

export function CheckingSession() {
  const t = useT();
  return (
    <main className="credential-screen" aria-busy="true">
      <div className="credential-card">
        <p>{t("app.session.checking")}</p>
      </div>
    </main>
  );
}

export function GatewayUnreachable({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <main className="credential-screen">
      <div className="credential-card">
        <p role="alert" className="error">
          {t("app.gateway.unreachable")}
        </p>
        <Button variant="default" type="button" onClick={onRetry}>
          {t("app.tryAgain")}
        </Button>
      </div>
    </main>
  );
}
