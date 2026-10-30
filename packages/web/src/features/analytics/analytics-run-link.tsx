// The run drawer's link to the run in Grafana (ADR-0046 decision 8): shown when Analytics is
// configured and the session may read it, which, like the observability status route, is the
// root's alone. Opens in a new tab, on this origin: the Gateway relays `/analytics/` to Grafana
// for the root's own session (ADR-0046 amendment 1), so there is no second sign-in.

import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";
import { type ConfigSource, analyticsRunHref, useAnalyticsUrl } from "./analytics-url.js";

export function AnalyticsRunLink({ api, runId }: { api: ConfigSource; runId: string }) {
  const t = useT();
  const url = useAnalyticsUrl(api);
  const can = useCan("observability.read");
  if (url === null || !can.allowed) return null;
  return (
    <a
      href={analyticsRunHref(url, runId)}
      target="_blank"
      rel="noopener noreferrer"
      className="small"
      title={t("analytics.runLinkTitle")}
    >
      {t("analytics.runLink")}
    </a>
  );
}
