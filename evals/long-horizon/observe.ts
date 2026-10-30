// Read-only deployment export. No model credentials, no SDK, no mutations.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findSecretsIn } from "../replay/trace.js";
import { totals } from "./metrics.js";
import { type OperatorReader, observeDeployment } from "./observer.js";

export async function exportDeployment(args: readonly string[], token: string): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !["--gateway", "--workspace", "--out"].includes(key) || !value || options.has(key))
      throw new Error("use --gateway <origin> --workspace <id> --out <new-private-file>");
    options.set(key, value);
  }
  const gateway = options.get("--gateway");
  const workspace = options.get("--workspace");
  const out = options.get("--out");
  if (!gateway || !workspace || !out || !token)
    throw new Error("set DESKMATES_OPERATOR_TOKEN and all three options");
  const base = new URL(gateway);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("--gateway must be an HTTP(S) origin without credentials");
  const api: OperatorReader = {
    api: async <T>(
      method: string,
      path: string,
      _body?: unknown,
      request?: { signal?: AbortSignal },
    ) => {
      if (method !== "GET" || !path.startsWith("/api/"))
        throw new Error("deployment observer permits only API GETs");
      const res = await fetch(new URL(path, base), {
        signal: request?.signal ?? AbortSignal.timeout(10_000),
        redirect: "error",
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, json: (await res.json()) as T };
    },
  };
  const observed = await observeDeployment(api, workspace);
  const report = {
    schemaVersion: 2,
    kind: "deployment_observation",
    observedAt: new Date().toISOString(),
    workspaceId: workspace,
    ...observed,
    totals: totals(
      observed.runs,
      observed.errors.map((e) => e.runId),
      { inventoryComplete: observed.inventoryComplete },
    ),
  };
  const findings = findSecretsIn(report);
  const json = JSON.stringify(report, null, 2);
  if (findings.length || json.includes(token))
    throw new Error("refused secret-shaped deployment export");
  writeFileSync(out, `${json}\n`, { flag: "wx", mode: 0o600 });
  if (observed.errors.length || !observed.inventoryComplete)
    throw new Error("deployment observation is partial; inspect the private report");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportDeployment(process.argv.slice(2), process.env.DESKMATES_OPERATOR_TOKEN ?? "").catch(
    (error) => {
      console.error(error instanceof Error ? error.message : "deployment export failed");
      process.exitCode = 1;
    },
  );
}
