import type { SsoProviderView } from "@deskmates/contracts";
import type { SessionFlows } from "../api/members-client.js";
import { ApiError } from "../api/types.js";
import { currentI18n } from "../i18n/intl.js";

/** Ask the Gateway for the IdP URL and leave for it; the callback brings the browser back. */
export async function startSso(
  flows: SessionFlows,
  provider: SsoProviderView,
  request: Parameters<SessionFlows["startSso"]>[1],
  csrf: string,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const started = await flows.startSso(provider.id, request, csrf);
    window.location.assign(started.authorizationUrl);
  } catch (err) {
    const { t } = currentI18n();
    onError(
      err instanceof ApiError && err.status >= 500
        ? t("app.sso.unavailable", { provider: provider.displayName })
        : err instanceof ApiError && err.status === 403
          ? t("app.sso.pageExpired")
          : t("app.sso.couldNotStart"),
    );
  }
}
