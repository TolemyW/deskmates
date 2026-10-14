// T1: ADR-0022 decision 1 / test plan AUTH-01, ROLE-02 baseline. Logins are keyed by issuer +
// subject with normalised local names; the migration seeds exactly one tenant and no account;
// the last Owner is protected inside the same transaction as the write.

import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { DEFAULT_TENANT_ID, UserStore, normalizeLoginName } from "./user-store.js";

const HASH = "$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";

let db: GatewayDb;
let users: UserStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  users = new UserStore(db);
});

function create(loginName: string, role: "owner" | "admin" | "member") {
  return users.createLocalUser({
    loginName,
    displayName: loginName,
    passwordHash: HASH,
    tenantId: DEFAULT_TENANT_ID,
    role,
  });
}

describe("users, logins and memberships", () => {
  it("starts locked: one Default Tenant and no account", () => {
    expect(users.userCount()).toBe(0);
    expect(users.getTenant(DEFAULT_TENANT_ID)).toMatchObject({
      status: "active",
      authPolicy: "local_or_sso",
      authPolicyVersion: 1,
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n).toBe(1);
  });

  it("normalises local login names and refuses anything outside the alphabet", () => {
    expect(normalizeLoginName("  Alice@Example.COM ")).toBe("alice@example.com");
    for (const bad of ["", " ", "a b", "alice;drop", "ä", "x".repeat(129), ".dot"])
      expect(() => normalizeLoginName(bad), bad).toThrow();
  });

  it("refuses a second account with the same normalised login name", () => {
    create("alice", "owner");
    expect(() => create("ALICE", "member")).toThrow("already exists");
    expect(users.userCount()).toBe(1);
  });

  it("keeps the same subject from different issuers apart", () => {
    const { user } = create("alice", "owner");
    db.prepare(
      `INSERT INTO user_logins (id, user_id, provider, issuer, subject, created_at)
       VALUES ('l2', ?, 'oidc', 'https://idp-a.example', 'alice', 'x')`,
    ).run(user.id);
    expect(users.findLocalLogin("alice")?.provider).toBe("local");
    expect(() =>
      db
        .prepare(
          `INSERT INTO user_logins (id, user_id, provider, issuer, subject, created_at)
           VALUES ('l3', ?, 'oidc', 'https://idp-a.example', 'alice', 'x')`,
        )
        .run(user.id),
    ).toThrow(/UNIQUE/);
  });

  it("only accepts Argon2id PHC strings as password material", () => {
    const { user } = create("alice", "owner");
    const login = users.findLocalLogin("alice");
    expect(login?.userId).toBe(user.id);
    expect(() => users.setPasswordHash(login?.id ?? "", "plaintext")).toThrow(/CHECK/);
  });
});
