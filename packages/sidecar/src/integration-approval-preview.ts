// ADR-0013 Amendment 2: a proposed Drive action, never provider-returned content.
import { createHash } from "node:crypto";
import { redactValue } from "./redact.js";

const MAX_PREVIEW_CHARS = 4096;

export function integrationApprovalPreview(
  actionId: string,
  input: unknown,
  secrets: readonly string[],
): Record<string, unknown> | undefined {
  if (!actionId.startsWith("googledrive.")) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const proposed = input as Record<string, unknown>;
  const safe = redactValue(proposed, secrets);
  // Binary payloads are identified by their exact bytes, not printed into the approval/ledger.
  if (typeof proposed.contentBase64 === "string") {
    const bytes = Buffer.from(proposed.contentBase64, "base64");
    safe.contentBase64 = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      encoding: "base64",
    };
  }
  const json = JSON.stringify(safe);
  const target = redactValue(
    { fileId: proposed.fileId, parents: proposed.parents, name: proposed.name },
    secrets,
  );
  const boundedTarget = Object.fromEntries(
    Object.entries(target).map(([key, value]) => [
      key,
      value !== undefined && JSON.stringify(value).length > 1024 ? "[target truncated]" : value,
    ]),
  );
  return {
    proposedInput: json.slice(0, MAX_PREVIEW_CHARS),
    complete: json.length <= MAX_PREVIEW_CHARS,
    totalCharacters: json.length,
    // The target is also separate so a long content body cannot push it out of the excerpt.
    target: boundedTarget,
  };
}
