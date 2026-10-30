// Host resources (ADR-0006 amendment 5): the administrator account's view of what the Docker host
// still holds for no active workspace (T2 leftovers, archived workspaces' runtimes, networks of a
// former product name, containers on the wrong network) and how full the address pools are. One
// action per finding; the Gateway classifies again before acting and refuses while a run is live.

import type {
  HostResource,
  HostResourceActionResult,
  HostResourceFinding,
  HostResourceReport,
} from "@deskmates/contracts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@deskmates/ui";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { NetworkApi } from "./api.js";

type Api = Pick<NetworkApi, "getHostResources" | "reattachHostResource" | "removeHostResource">;

/** Bytes in the largest unit that keeps the number at or above one. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function resourceLabel(r: HostResource): string {
  return `${r.kind} ${r.name}`;
}

export function HostResourcesSection({ api }: { api: Api }) {
  const t = useT();
  const [report, setReport] = useState<HostResourceReport>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setReport(await api.getHostResources());
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (finding: HostResourceFinding) => {
    const action = finding.action;
    if (action === undefined) return;
    const question =
      action === "remove"
        ? t("network.host.confirmRemove", {
            count: finding.resources.length,
            names: finding.resources.map((r) => r.name).join(", "),
          })
        : t("network.host.confirmReattach", {
            workspace: finding.workspaceName ?? finding.workspaceId ?? "",
          });
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result: HostResourceActionResult =
        action === "remove"
          ? await api.removeHostResource(finding.id)
          : await api.reattachHostResource(finding.id);
      setReport(result.report);
      setNotice(
        action === "remove"
          ? t("network.host.removed", { count: result.removed?.length ?? 0 })
          : result.repaired
            ? t("network.host.repaired")
            : t("network.host.notRepaired", { problem: result.problem ?? "" }),
      );
    } catch (err) {
      // The finding may have changed under the refusal: show the host as it is now, then why.
      await reload();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pool = report?.pool;
  return (
    <section className="card network-host" aria-labelledby="network-host-title">
      <div className="network-workspace-head">
        <h2 id="network-host-title">{t("network.host.title")}</h2>
        <Button size="sm" disabled={busy} onClick={() => void reload()}>
          {t("network.host.refresh")}
        </Button>
      </div>
      <p className="muted small">{t("network.host.intro")}</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <output className="network-host-notice">{notice}</output> : null}
      {report === undefined ? (
        error ? null : (
          <p className="muted">{t("network.host.loading")}</p>
        )
      ) : !report.checked ? (
        <p className="muted">
          {report.error
            ? t("network.host.unchecked", { error: report.error })
            : t("network.host.unsupported")}
        </p>
      ) : (
        <>
          {pool ? (
            <p className="network-host-pool" data-status={pool.status}>
              <strong>{t(`network.host.pool.${pool.status}`)}</strong>{" "}
              {t("network.host.pool", {
                free: pool.free,
                capacity: pool.capacity,
                source:
                  pool.source === "daemon"
                    ? t("network.host.pool.configured")
                    : t("network.host.pool.default"),
              })}
              {pool.status === "low" || pool.status === "exhausted" ? (
                <span className="muted small"> {t("network.host.poolHint")}</span>
              ) : null}
            </p>
          ) : null}
          {report.findings.length === 0 ? (
            <p className="muted">{t("network.host.empty", { healthy: report.healthy })}</p>
          ) : (
            <Table className="network-table" aria-label={t("network.host.title")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("network.host.col.what")}</TableHead>
                  <TableHead>{t("network.host.col.workspace")}</TableHead>
                  <TableHead>{t("network.host.col.size")}</TableHead>
                  <TableHead>{t("network.host.col.age")}</TableHead>
                  <TableHead>{t("network.host.col.why")}</TableHead>
                  <TableHead>{t("network.host.col.action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.findings.map((finding) => (
                  <TableRow key={finding.id} data-flag={finding.flag}>
                    <TableCell>
                      <ul className="network-rule-list">
                        {finding.resources.map((r) => (
                          <li key={`${r.kind}:${r.id}`}>
                            <code>{resourceLabel(r)}</code>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell>
                      {finding.workspaceName ??
                        finding.workspaceId ??
                        t("network.host.noWorkspace")}
                      {finding.workspaceName && finding.workspaceId ? (
                        <p className="muted small">
                          <code>{finding.workspaceId}</code>
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>{formatBytes(finding.sizeBytes)}</TableCell>
                    <TableCell>{formatDateTime(finding.createdAt)}</TableCell>
                    <TableCell>
                      <strong>{t(`network.host.flag.${finding.flag}`)}</strong>
                      <p className="muted small">{finding.detail}</p>
                    </TableCell>
                    <TableCell>
                      {finding.action === undefined ? (
                        <span className="muted">{t("network.host.noAction")}</span>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || finding.blocked !== undefined}
                            onClick={() => void act(finding)}
                          >
                            {finding.action === "remove"
                              ? t("network.host.remove")
                              : t("network.host.reattach")}
                          </Button>
                          {finding.blocked ? (
                            <p className="muted small">
                              {t("network.host.blocked", { reason: finding.blocked })}
                            </p>
                          ) : null}
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}
