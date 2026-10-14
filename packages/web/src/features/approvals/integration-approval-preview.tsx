import { useT } from "../../i18n/i18n-provider.js";

// Display only the sidecar's proposed-action preview, as inert text.
export function IntegrationApprovalPreview({ input }: { input: Record<string, unknown> }) {
  const t = useT();
  if (input.service !== "googledrive" || !input.preview || typeof input.preview !== "object")
    return null;
  const preview = input.preview as Record<string, unknown>;
  if (typeof preview.proposedInput !== "string") return null;
  return (
    <section aria-label={t("integrationApprovalPreview.region")} className="small">
      <p>
        {t("integrationApprovalPreview.connection", { name: String(input.connectionName ?? "") })}
      </p>
      <p>
        {t("integrationApprovalPreview.target", {
          target: JSON.stringify(preview.target) ?? "",
        })}
      </p>
      <p>{t("integrationApprovalPreview.outgoing")}</p>
      <pre className="whitespace-pre-wrap break-all">{preview.proposedInput}</pre>
      {preview.complete === false ? <p>{t("integrationApprovalPreview.truncated")}</p> : null}
    </section>
  );
}
