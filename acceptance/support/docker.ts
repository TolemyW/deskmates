// Docker preconditions shared by the T2 and T3 stacks: is the daemon reachable, and is the
// workspace image present. A missing image is built once through scripts/build-workspace-image.sh
// (the same path `npm run image:workspace` takes), so a fresh checkout can run the stack tests
// with nothing but Docker.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  DEFAULT_EGRESS_PROXY_IMAGE,
  DockerProvider,
  type DockerProviderOptions,
} from "@deskmates/sandbox-docker";
import { REPO_ROOT } from "./env.js";
import { isImageId, requireImageId } from "./image-id.mjs";

export { IMAGE_ID_PATTERN, isImageId, requireImageId } from "./image-id.mjs";

export const DEFAULT_WORKSPACE_IMAGE = "deskmates/workspace:dev";

export function egressProxyImage(): string {
  return process.env.EGRESS_PROXY_IMAGE?.trim() || DEFAULT_EGRESS_PROXY_IMAGE;
}

/** Match the production factory's operator-selected host route, including Colima deployments. */
export function testDockerProviderOptions(
  env: NodeJS.ProcessEnv = process.env,
): DockerProviderOptions {
  const hostTarget = env.DESKMATES_HOST_TARGET?.trim();
  // The host's resolver settings, as the Gateway reads them (ADR-0010). On a host whose port-53
  // answers are fake IPs (Testbox), the public-reachability cases need the DoH resolver too.
  const doh = env.EGRESS_PROXY_DOH_URL?.trim();
  const dns = (env.EGRESS_PROXY_DNS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    egressProxyImage: egressProxyImage(),
    ...(hostTarget ? { hostTarget } : {}),
    ...(doh ? { egressProxyDohUrl: doh } : {}),
    ...(dns.length > 0 ? { egressProxyDns: dns } : {}),
  };
}

export function workspaceImage(): string {
  return (process.env.WORKSPACE_IMAGE ?? "").trim() || DEFAULT_WORKSPACE_IMAGE;
}

/**
 * The workspace image of a live run, pinned by Docker image ID. Call it where the suite actually
 * runs (inside `beforeAll`), so a skipped suite does not throw at import.
 */
export function requireWorkspaceImageId(): string {
  return requireImageId(process.env.WORKSPACE_IMAGE?.trim(), "WORKSPACE_IMAGE");
}

/** Never forwarded, whatever else the rules say: the two secrets `env.ts` loads from `.env`. */
const ENV_DROP: ReadonlySet<string> = new Set(["MODEL_AUTH_TOKEN", "GATEWAY_SECRETS_KEY"]);

/** A secret-looking name: contains TOKEN or SECRET, or ends with KEY. */
const ENV_SECRET_NAME = /TOKEN|SECRET|KEY$/i;

/** Secret-looking names the build genuinely needs; these survive `ENV_SECRET_NAME`. */
const ENV_KEEP: ReadonlySet<string> = new Set(["DOCKER_HOST", "PATH", "HOME", "WORKSPACE_IMAGE"]);
const ENV_KEEP_PREFIXES = ["DESKMATES_", "DOCKER_"];

/**
 * The environment handed to `scripts/build-workspace-image.sh`. `env.ts` loads `.env` into
 * `process.env` so the T3 suites can read the model variables, which would otherwise put
 * `MODEL_AUTH_TOKEN` and anything else secret-shaped into a build subprocess (and from there into
 * `npm`, `docker build` and every hook they run). Nothing here needs a credential: the build
 * talks to the local daemon and to the npm registry.
 */
export function buildSubprocessEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = (name: string): boolean =>
    ENV_KEEP.has(name) || ENV_KEEP_PREFIXES.some((p) => name.startsWith(p));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ENV_DROP.has(name)) continue;
    if (ENV_SECRET_NAME.test(name) && !keep(name)) continue;
    out[name] = value;
  }
  return out;
}

/** True when the daemon answers `/_ping`; false (never a throw) otherwise. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const provider = new DockerProvider();
    const res = await provider.client.request("GET", "/_ping", undefined, { timeoutMs: 3000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function imageExists(docker: DockerProvider, image: string): Promise<boolean> {
  const res = await docker.client.request("GET", `/images/${encodeURIComponent(image)}/json`);
  return res.status === 200;
}

/**
 * Build the workspace image when it is missing (or when DESKMATES_REBUILD_WORKSPACE_IMAGE=1, for
 * a checkout whose sidecar changed since the last build). A cold build pulls the Playwright base
 * and takes minutes; a cached one takes seconds.
 *
 * An image ID is never built: a build cannot produce a given ID, so an ID that is absent locally
 * (or combined with a rebuild request) fails closed.
 */
export async function ensureWorkspaceImage(docker: DockerProvider, image: string): Promise<void> {
  const rebuild = process.env.DESKMATES_REBUILD_WORKSPACE_IMAGE === "1";
  if (isImageId(image)) {
    if (rebuild) {
      throw new Error(
        `DESKMATES_REBUILD_WORKSPACE_IMAGE=1 cannot rebuild pinned image ${image}; build, then pass the new ID`,
      );
    }
    if (await imageExists(docker, image)) return;
    throw new Error(`workspace image ${image} is not present locally; a build cannot produce it`);
  }
  if (!rebuild && (await imageExists(docker, image))) return;
  const started = Date.now();
  console.log(`[acceptance] building ${image} via scripts/build-workspace-image.sh`);
  const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "build-workspace-image.sh")], {
    env: { ...buildSubprocessEnv(), WORKSPACE_IMAGE: image },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`workspace image build failed (exit ${r.status}):\n${r.stderr.slice(-4000)}`);
  }
  console.log(`[acceptance] built ${image} in ${Math.round((Date.now() - started) / 1000)}s`);
}
