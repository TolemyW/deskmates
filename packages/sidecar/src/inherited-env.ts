// The part of the container environment a run's child processes may inherit: the SDK's CLI
// subprocess, the model jobs, and the OpenAI runtime's shell tool (ADR-0044).

/**
 * Environment variables the SDK's CLI subprocess may inherit from the container. An allowlist,
 * not a denylist: the container environment belongs to the whole workspace and holds whatever an
 * operator, an image layer or another process put there, and anything the CLI recognises changes
 * how the run behaves. `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` would give the run a
 * second, unmetered way to reach a model; `ANTHROPIC_MODEL` would silently swap the model the
 * Gateway chose and priced; `HTTPS_PROXY` would route every model call through a third party;
 * `NODE_OPTIONS` can load arbitrary code into the CLI process. None of them can be named here, so
 * none of them can be forwarded by accident when the next one is invented.
 */
const ENV_PASSTHROUGH = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "DISPLAY",
  "TMPDIR",
  "TERM",
  "SHELL",
  "USER",
]);

/** Prefixes whose whole family passes: locale categories and this project's own settings. */
const ENV_PASSTHROUGH_PREFIXES = ["LC_", "DESKMATES_"];

export function inheritedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_PASSTHROUGH.has(k) || ENV_PASSTHROUGH_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}
