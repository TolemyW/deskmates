// The Secrets Store: values the Gateway must be able to read back (a connector's URL and
// credential) encrypted at rest with GATEWAY_SECRETS_KEY in the `secrets` table (0001). AES-256-GCM
// with a random 96-bit nonce per value; the blob is nonce || tag || ciphertext. Without a key the
// store refuses to hold anything rather than fall back to clear text.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DeskmatesError } from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

/** `gateway` holds the Gateway's own credentials for a runtime (ADR-0013 amendment 3). */
export type SecretOwnerKind = "connector" | "workspace" | "model" | "oidc_provider" | "gateway";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretsStore {
  constructor(
    private readonly db: GatewayDb,
    /** Base64 of 32 bytes, from `GATEWAY_SECRETS_KEY`; empty disables the store. */
    private readonly keyBase64: string,
  ) {}

  /** Whether `GATEWAY_SECRETS_KEY` is set; callers that would mint a credential check first. */
  get enabled(): boolean {
    return this.keyBase64 !== "" && Buffer.from(this.keyBase64, "base64").length === 32;
  }

  private key(): Buffer {
    const key = Buffer.from(this.keyBase64, "base64");
    if (this.keyBase64 === "" || key.length !== 32) {
      throw new DeskmatesError(
        "validation",
        "GATEWAY_SECRETS_KEY must be set to 32 bytes of base64 before a secret can be stored",
      );
    }
    return key;
  }

  /** Encrypts and stores `plaintext`; returns the secret id a row references. */
  put(ownerKind: SecretOwnerKind, ownerId: string, plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key(), nonce);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const blob = Buffer.concat([nonce, cipher.getAuthTag(), body]);
    const id = newId("sec");
    this.db
      .prepare(
        "INSERT INTO secrets (id, owner_kind, owner_id, encrypted_blob, rotated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, ownerKind, ownerId, blob, nowIso());
    return id;
  }

  /** Removes a value that is no longer valid anywhere (a revoked runtime token). */
  delete(id: string): void {
    this.db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
  }

  get(id: string): string {
    const row = this.db.prepare("SELECT encrypted_blob FROM secrets WHERE id = ?").get(id) as
      | { encrypted_blob: Buffer }
      | undefined;
    if (!row) throw new DeskmatesError("not_found", "secret not found", { secretId: id });
    const blob = row.encrypted_blob;
    const decipher = createDecipheriv("aes-256-gcm", this.key(), blob.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(blob.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(blob.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }
}
