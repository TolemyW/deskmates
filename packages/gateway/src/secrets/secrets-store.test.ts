// T1: the Secrets Store encrypts at rest with GATEWAY_SECRETS_KEY (design §6; ADR-0012 item 2).

import { afterEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { SecretsStore } from "./secrets-store.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const dbs: GatewayDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function db(): GatewayDb {
  const d = openDatabase(":memory:");
  dbs.push(d);
  return d;
}

describe("SecretsStore", () => {
  it("round-trips a secret and never writes the plaintext", () => {
    const d = db();
    const store = new SecretsStore(d, KEY);
    const id = store.put("connector", "con_1", "https://db.internal.test/?token=s3cr3t-value");
    expect(store.get(id)).toBe("https://db.internal.test/?token=s3cr3t-value");
    const dump = d.serialize().toString("latin1");
    expect(dump).not.toContain("s3cr3t-value");
    expect(dump).not.toContain("db.internal.test");
  });

  it("uses a fresh nonce, so the same plaintext never encrypts to the same blob", () => {
    const d = db();
    const store = new SecretsStore(d, KEY);
    const a = store.put("connector", "con_1", "same");
    const b = store.put("connector", "con_2", "same");
    const blobs = d.prepare("SELECT encrypted_blob FROM secrets WHERE id IN (?, ?)").all(a, b) as {
      encrypted_blob: Buffer;
    }[];
    expect(blobs[0]?.encrypted_blob.equals(blobs[1]?.encrypted_blob as Buffer)).toBe(false);
  });

  it("refuses to store anything without a 32-byte key", () => {
    expect(() => new SecretsStore(db(), "").put("connector", "c", "x")).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    expect(() => new SecretsStore(db(), "c2hvcnQ=").put("connector", "c", "x")).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("fails to decrypt with another key", () => {
    const d = db();
    const id = new SecretsStore(d, KEY).put("connector", "c", "x");
    expect(() => new SecretsStore(d, Buffer.alloc(32, 9).toString("base64")).get(id)).toThrow();
  });
});
