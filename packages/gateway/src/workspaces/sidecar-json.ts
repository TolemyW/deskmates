// One fixed `deskmates-sidecar <subcommand>` inside a workspace container, with its request as JSON
// on stdin and its answer as one JSON object on stdout. The command and its arguments never come
// from the request, so nothing a caller sends becomes part of a shell string.

import { DeskmatesError, type SandboxHandle } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

export async function execSidecarJson(
  ctx: Pick<GatewayContext, "provider">,
  handle: SandboxHandle,
  subcommand: string,
  input: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const result = await ctx.provider.exec(handle, {
    cmd: ["deskmates-sidecar", subcommand],
    stdin: JSON.stringify(input),
    timeoutMs,
  });
  if (result.timedOut)
    throw new DeskmatesError("sandbox_unavailable", `${subcommand} timed out; reload and retry`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new DeskmatesError("sandbox_unavailable", `${subcommand} returned an invalid response`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DeskmatesError("sandbox_unavailable", `${subcommand} returned an invalid response`);
  const record = value as Record<string, unknown>;
  if (result.exitCode !== 0)
    throw new DeskmatesError(
      "invalid_transition",
      typeof record.error === "string" ? record.error : `${subcommand} failed`,
    );
  return record;
}
