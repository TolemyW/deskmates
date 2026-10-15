// Shared bits of the network screens: a one-line rule summary and the publication outcomes a
// change reports per workspace (ADR-0027 amendment 1 decision 7).

import type { NetworkPublication, NetworkRule } from "@deskmates/contracts";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";

const OUTCOME: Record<NetworkPublication["status"], MessageKey> = {
  applied: "network.outcome.applied",
  unchanged: "network.outcome.unchanged",
  not_running: "network.outcome.not_running",
  failed: "network.outcome.failed",
};

/** `http 10.20.30.0/24 :23001` or `https console.example.lan→10.0.0.5 :443`. */
export function ruleSummary(rule: NetworkRule): string {
  const target = rule.kind === "subnet" ? rule.cidr : `${rule.hostname}→${rule.address}`;
  return `${rule.schemes.join("/")} ${target} :${rule.ports.join(",")}`;
}

export function Publications({ publications }: { publications: NetworkPublication[] }) {
  const t = useT();
  if (publications.length === 0) return null;
  return (
    <ul className="network-publications" aria-live="polite">
      {publications.map((p) => (
        <li key={p.workspaceId} data-status={p.status}>
          {t("network.publication", { workspace: p.workspaceId, status: t(OUTCOME[p.status]) })}
          {p.policyHash ? <code> {p.policyHash.slice(0, 12)}</code> : null}
          {p.error ? <span> {p.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}
