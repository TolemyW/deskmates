// Whether a bot's model can see images (issue #87). The value comes from a recorded synthetic
// probe; an uncertain probe shows as unconfirmed with its reason and a Retry. Opening this screen
// never runs a probe: only the Retry button does.

import { type VisionProbeView, type WorkspaceId, visionPolicyFor } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";

const STATUS: Record<VisionProbeView["status"], MessageKey> = {
  supported: "management.vision.supported",
  unsupported: "management.vision.unsupported",
  unknown: "management.vision.unknown",
  pending: "management.vision.pending",
};

const REASON: Record<NonNullable<VisionProbeView["reason"]>, MessageKey> = {
  verified_answer: "management.vision.reason.verified_answer",
  explicit_refusal: "management.vision.reason.explicit_refusal",
  wrong_answer: "management.vision.reason.wrong_answer",
  no_transport_evidence: "management.vision.reason.no_transport_evidence",
  job_failed: "management.vision.reason.job_failed",
  blocked: "management.vision.reason.blocked",
  not_probed: "management.vision.reason.not_probed",
};

export function VisionCapability({
  api,
  workspaceId,
  model,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  model: string;
}) {
  const t = useT();
  const canRetry = useCan("bot.configure").allowed;
  const [probe, setProbe] = useState<VisionProbeView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const pending = probe?.status === "pending";
  useEffect(() => {
    let active = true;
    const load = () =>
      api
        .listModelCapabilities(workspaceId)
        .then((list) => {
          if (!active) return;
          setProbe(
            list.find((c) => c.model === model)?.vision ?? {
              id: null,
              model,
              status: "unknown",
              reason: "not_probed",
            },
          );
        })
        .catch((err: unknown) => {
          if (active) setError(errorMessage(err));
        });
    void load();
    const timer = pending ? setInterval(() => void load(), 2000) : undefined;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [api, workspaceId, model, pending]);

  const retry = async () => {
    setBusy(true);
    setError("");
    try {
      setProbe(await api.probeVision(workspaceId, model));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!probe) return null;
  return (
    <div className="vision-capability" data-status={probe.status}>
      <p>
        {t("management.vision.label", { model })} <strong>{t(STATUS[probe.status])}</strong>
        {probe.reason && probe.status !== "pending" ? ` · ${t(REASON[probe.reason])}` : ""}
      </p>
      {visionPolicyFor(probe) === "withhold" ? (
        <p className="muted small" data-testid="vision-withheld">
          {t("management.vision.withheld")}
        </p>
      ) : null}
      {probe.answer && probe.status !== "supported" ? (
        <p className="muted small">{t("management.vision.answer", { answer: probe.answer })}</p>
      ) : null}
      {probe.status === "unknown" ? (
        <Button type="button" disabled={busy || !canRetry} onClick={() => void retry()}>
          {t("management.vision.retry")}
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
