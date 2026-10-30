// T1 (ADR-0045 decision 3): values live in the encrypted Secrets Store, metadata in the catalog.
// Without a key a create or replacement fails closed; a database dump holds no plaintext; a
// replacement changes the secret reference and the revision together and deletes the old blob;
// a disabled, stale or foreign entry decrypts nothing; deleting an entry or its workspace deletes
// its blob. The SecretsStore's own tests (`secrets/secrets-store.test.ts`) cover the cipher.
// Metric: plaintext persistent copies, target 0.

import { DeskmatesError, type WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { SecretsStore } from "../secrets/secrets-store.js";
import { TEST_SECRETS_KEY } from "../test-support/connector-fixture.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { VaultStore } from "./store.js";

const PASSWORD = "synthetic-store-password-0d4b";
const USERNAME = "synthetic-store-user-63e9";
const TOKEN = "synthetic-store-token-ff10";

const dbs: GatewayDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function setup(key = TEST_SECRETS_KEY) {
  const db = openDatabase(":memory:");
  dbs.push(db);
  const workspaces = new WorkspaceStore(db);
  const workspace = (name: string): WorkspaceId =>
    workspaces.create({ name, sandboxProvider: "docker" }).id;
  const secrets = new SecretsStore(db, key);
  return { db, secrets, store: new VaultStore(db, secrets), a: workspace("a"), b: workspace("b") };
}

const login = {
  name: "Console",
  type: "browser_login",
  targetOrigin: "https://console.example.test",
};

describe("vault store", () => {
  it("refuses to store or replace anything without a key", () => {
    const { store, a } = setup("");
    expect(store.available).toBe(false);
    expect(() => store.create(a, { ...login, password: PASSWORD }, "user:t")).toThrow(
      expect.objectContaining({ code: "validation", details: { reason: "vault_unavailable" } }),
    );
  });

  it("keeps no plaintext copy anywhere in the database", () => {
    const { db, store, a } = setup();
    store.create(a, { ...login, username: USERNAME, password: PASSWORD }, "user:t");
    const token = store.create(
      a,
      {
        name: "API",
        type: "http_header_token",
        targetOrigin: "https://api.example.test",
        token: TOKEN,
      },
      "user:t",
    );
    store.replaceValue(a, token.id, { expectedRevision: 1, token: `${TOKEN}-2` }, "user:t");
    const dump = db.serialize().toString("latin1");
    for (const canary of [PASSWORD, USERNAME, TOKEN]) expect(dump).not.toContain(canary);
  });

  it("replaces the secret reference and the revision together and drops the old blob", () => {
    const { db, store, a } = setup();
    const entry = store.create(a, { ...login, password: PASSWORD }, "user:t");
    const secretOf = () =>
      (
        db.prepare("SELECT secret_id FROM vault_entries WHERE id = ?").get(entry.id) as {
          secret_id: string;
        }
      ).secret_id;
    const before = secretOf();
    const replaced = store.replaceValue(
      a,
      entry.id,
      { expectedRevision: 1, password: `${PASSWORD}-new` },
      "user:t",
    );
    expect(replaced.revision).toBe(2);
    expect(secretOf()).not.toBe(before);
    expect(db.prepare("SELECT 1 FROM secrets WHERE id = ?").get(before)).toBeUndefined();
    expect(store.payload(a, entry.id, 1)).toBeUndefined();
    expect(store.payload(a, entry.id, 2)).toEqual({ username: "", password: `${PASSWORD}-new` });
    // A stale replacement changes nothing.
    expect(() =>
      store.replaceValue(a, entry.id, { expectedRevision: 1, password: "x" }, "user:t"),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(store.payload(a, entry.id, 2)).toEqual({ username: "", password: `${PASSWORD}-new` });
  });

  it("decrypts nothing for a disabled entry, another workspace or a foreign secret", () => {
    const { db, secrets, store, a, b } = setup();
    const entry = store.create(a, { ...login, password: PASSWORD }, "user:t");
    expect(store.payload(b, entry.id, 1)).toBeUndefined();
    store.patch(a, entry.id, { expectedRevision: 1, enabled: false }, "user:t");
    expect(store.payload(a, entry.id, 2)).toBeUndefined();
    store.patch(a, entry.id, { expectedRevision: 2, enabled: true }, "user:t");
    expect(store.payload(a, entry.id, 3)).toEqual({ username: "", password: PASSWORD });
    // The catalog-to-secret binding is checked against the workspace before decryption.
    const foreign = secrets.put("workspace", b, JSON.stringify({ username: "", password: "b" }));
    db.prepare("UPDATE vault_entries SET secret_id = ? WHERE id = ?").run(foreign, entry.id);
    expect(store.payload(a, entry.id, 3)).toBeUndefined();
  });

  it("deletes the encrypted blob with the entry and with its workspace", () => {
    const { db, store, a, b } = setup();
    const one = store.create(a, { ...login, password: PASSWORD }, "user:t");
    store.create(b, { ...login, password: PASSWORD }, "user:t");
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n;
    expect(count()).toBe(2);
    store.delete(a, one.id, 1, "user:t");
    expect(count()).toBe(1);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(b);
    expect(count()).toBe(0);
  });

  it("names the field and never the value when it refuses input", () => {
    const { store, a } = setup();
    try {
      store.create(a, { ...login, password: `${PASSWORD}\u0000` }, "user:t");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DeskmatesError);
      expect(
        JSON.stringify({ m: (err as Error).message, d: (err as DeskmatesError).details }),
      ).not.toContain(PASSWORD);
    }
  });
});
