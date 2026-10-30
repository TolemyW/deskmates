import { createHash } from "node:crypto";
import type { RunId, TaskDeliverRequest } from "@deskmates/contracts";
import type { VerifiedFile } from "../files/file-verification.js";

/** Object-key order is immaterial; array order and explicit null are preserved. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** File verification time is an observation, not content; changed bytes must be a new delivery. */
export function deliveryRequestHash(
  runId: RunId,
  attempt: number,
  scopeVersion: number,
  input: TaskDeliverRequest,
  verified: ReadonlyMap<string, VerifiedFile>,
): string {
  const request = {
    runId,
    attempt,
    scopeVersion,
    summary: input.summary,
    output: input.output ?? null,
    outputProvided: input.output !== undefined,
    outstanding: input.outstanding ?? [],
    artifacts: input.artifacts.map(({ label, path }) => ({
      label,
      path,
      sha256: verified.get(path)?.sha256,
      sizeBytes: verified.get(path)?.sizeBytes,
    })),
  };
  return createHash("sha256").update(canonical(request)).digest("hex");
}
