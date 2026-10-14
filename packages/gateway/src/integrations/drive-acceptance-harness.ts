// Narrow acceptance procedure, with injected I/O and no CLI/environment/credential discovery.
// The offline test is its only caller until an operator approves an account and existing folder.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { IntegrationExecuteResult, IntegrationSearchResult } from "@deskmates/contracts";
import { PINNED_DRIVE_DEFINITIONS } from "./drive-pinned-definitions.js";
import type { RuntimeActionDefinition } from "./runtime-adapter.js";

export const DRIVE_RUNTIME = {
  version: "1.7.0",
  revision: "4505aed0c75b719fd13810d9cef00940fb05e16d",
  image:
    "ghcr.io/oomol-lab/open-connector@sha256:55b1c424b454451d61e34ea6e2f540e625569d8f4c31cc4c5ec8052dadda4c9b",
  provider: "googledrive",
} as const;
export const DRIVE_ACCEPTANCE_TEXT = "Deskmates M4 synthetic Drive acceptance artifact.\n";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface DriveAcceptanceBinding {
  /** Caller-verified account and already-existing, dedicated folder; never discovered broadly. */
  account: string;
  folderId: string;
  connectionName: string;
  runLabel: string;
}
export interface DriveAcceptanceIO {
  search(actionId: string): Promise<IntegrationSearchResult>;
  definition(actionId: string): Promise<RuntimeActionDefinition>;
  /** Through the normal sidecar L2 approval path in a live trial. */
  execute(actionId: string, input: Record<string, unknown>): Promise<IntegrationExecuteResult>;
  download(downloadUrl: string): Promise<Uint8Array>;
  /** Save through the workspace delivery path and read back the persisted bytes. */
  deliver(bytes: Uint8Array): Promise<{ path: string; readBack: Uint8Array }>;
}

export interface DriveAcceptancePartial {
  receipts: string[];
  fileId?: string;
  writeAttempted: boolean;
  stage: string;
}

/** Safe recovery facts survive ambiguous writes and every post-create failure. */
export class DriveAcceptanceFailure extends Error {
  constructor(readonly partial: DriveAcceptancePartial) {
    super(`Drive acceptance failed during ${partial.stage}; inspect partial receipts before retry`);
    this.name = "DriveAcceptanceFailure";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Drive result");
  return value as Record<string, unknown>;
}

export async function verifyDriveAcceptance(
  binding: DriveAcceptanceBinding,
  io: DriveAcceptanceIO,
) {
  if (
    !binding.account ||
    !binding.connectionName ||
    !/^[A-Za-z0-9_-]+$/.test(binding.folderId) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(binding.runLabel)
  )
    throw new Error("Explicit Drive test binding required");
  // Fail closed on the complete source-pinned schemas before any provider action.
  for (const expected of PINNED_DRIVE_DEFINITIONS) {
    const current = await io.definition(expected.id);
    if (!isDeepStrictEqual(current, expected))
      throw new Error(`Pinned Drive schema mismatch: ${expected.id}`);
  }
  // Exact identities and required acceptance parameters, never fuzzy-match an action to execute.
  const parameters = {
    "googledrive.files.list": ["q", "pageSize"],
    "googledrive.files.get": ["fileId", "alt"],
    "googledrive.files.create": ["name", "mimeType", "parents", "text"],
  };
  for (const [id, inputs] of Object.entries(parameters)) {
    const result = await io.search(id);
    const action = result.actions.find(
      (a) => a.actionId === id && a.service === DRIVE_RUNTIME.provider,
    );
    if (
      !action ||
      action.operationType !== (id.endsWith("create") ? "write" : "read") ||
      inputs.some((name) => !action.inputs.some((i) => i.name === name))
    )
      throw new Error(`Pinned Drive catalog mismatch: ${id}`);
  }
  const receipts: string[] = [];
  const partial: DriveAcceptancePartial = {
    receipts,
    writeAttempted: false,
    stage: "folder_metadata",
  };
  const execute = async (id: string, input: Record<string, unknown>) => {
    const out = await io.execute(id, input);
    if (
      out.actionId !== id ||
      out.service !== DRIVE_RUNTIME.provider ||
      out.connectionName !== binding.connectionName
    )
      throw new Error("Drive execution binding mismatch");
    if (out.executionId) receipts.push(out.executionId);
    if (id === "googledrive.files.create" && out.ok && out.data && typeof out.data === "object") {
      const candidate = (out.data as Record<string, unknown>).id;
      if (typeof candidate === "string" && /^[A-Za-z0-9_-]+$/.test(candidate))
        partial.fileId = candidate;
    }
    if (!out.ok) throw new Error(`Drive action failed: ${out.error?.code ?? "unknown"}`);
    if (!out.executionId) throw new Error("Drive execution receipt missing");
    return object(out.data);
  };
  try {
    // Validate the provided folder, then constrain enumeration to it. Never create a test folder.
    const folder = await execute("googledrive.files.get", { fileId: binding.folderId });
    if (
      folder.id !== binding.folderId ||
      folder.mimeType !== "application/vnd.google-apps.folder" ||
      folder.trashed === true
    )
      throw new Error("Dedicated Drive test folder mismatch");
    partial.stage = "folder_list";
    await execute("googledrive.files.list", {
      q: `'${binding.folderId}' in parents and trashed = false`,
      pageSize: 5,
    });
    const name = `deskmates-m4-${binding.runLabel}.txt`;
    partial.stage = "create";
    partial.writeAttempted = true;
    const created = await execute("googledrive.files.create", {
      name,
      mimeType: "text/plain",
      parents: [binding.folderId],
      text: DRIVE_ACCEPTANCE_TEXT,
    });
    if (typeof created.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(created.id))
      throw new Error("Created file ID missing");
    partial.fileId = created.id;
    partial.stage = "created_metadata";
    const metadata = await execute("googledrive.files.get", { fileId: created.id });
    if (
      metadata.id !== created.id ||
      metadata.name !== name ||
      !Array.isArray(metadata.parents) ||
      metadata.parents.length !== 1 ||
      metadata.parents[0] !== binding.folderId
    )
      throw new Error("Created file target mismatch");
    partial.stage = "media";
    const media = await execute("googledrive.files.get", { fileId: created.id, alt: "media" });
    const transit = object(media.file);
    if (typeof transit.downloadUrl !== "string")
      throw new Error("Drive transit result binding unverified");
    partial.stage = "transit";
    const bytes = await io.download(transit.downloadUrl);
    const expected = digest(new TextEncoder().encode(DRIVE_ACCEPTANCE_TEXT));
    if (digest(bytes) !== expected) throw new Error("Drive downloaded content mismatch");
    partial.stage = "delivery";
    const artifact = await io.deliver(bytes);
    if (digest(artifact.readBack) !== expected)
      throw new Error("Delivered artifact content mismatch");
    return {
      runtime: DRIVE_RUNTIME,
      fileId: created.id,
      artifactPath: artifact.path,
      sha256: expected,
      bytes: bytes.length,
      receipts,
    };
  } catch {
    throw new DriveAcceptanceFailure({ ...partial, receipts: [...receipts] });
  }
}
