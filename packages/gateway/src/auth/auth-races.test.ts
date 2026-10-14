// T1: ADR-0022 decision 2 / test plan AUTH-01, AUTH-04 under concurrency. Password verification
// is asynchronous; whatever finishes while it runs (a maintenance reset, a disable, a logout)
// must win over the verification that started before it, and the failure budget must count
// attempts that are still verifying. A gated verifier orders the race deterministically.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { createOwner } from "../test-support/owner.js";
import { AuthService, type PasswordVerifier } from "./auth-service.js";
import { PasswordHasher } from "./passwords.js";

const OLD = "the original long password";
const RESET = "a maintenance reset password";
const CHANGED = "the user's own new password";

/** Real Argon2id, but each verification waits for the test to open the gate. */
class GatedHasher implements PasswordVerifier {
  private readonly inner = new PasswordHasher({ memoryKiB: 1024, iterations: 1, parallelism: 1 });
  private gate: Promise<void> | undefined;
  private open: () => void = () => {};
  verifyCalls = 0;

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open();
    this.gate = undefined;
  }

  hash(password: string): Promise<string> {
    return this.inner.hash(password);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    this.verifyCalls += 1;
    const gate = this.gate;
    const result = await this.inner.verify(hash, password);
    if (gate) await gate;
    return result;
  }

  async verifyAgainstNothing(password: string): Promise<false> {
    this.verifyCalls += 1;
    const gate = this.gate;
    await this.inner.verifyAgainstNothing(password);
    if (gate) await gate;
    return false;
  }
}

let db: GatewayDb;
let hasher: GatedHasher;
let auth: AuthService;

beforeEach(async () => {
  db = openDatabase(":memory:");
  hasher = new GatedHasher();
  auth = new AuthService(db, { liveSweepMs: 0 }, () => new Date(), { hasher });
  await createOwner(
    auth,
    { loginName: "owner", displayName: "Owner", password: OLD },
    { root: false },
  );
});
afterEach(() => {
  hasher.release();
  db.close();
});

function sessionCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL").get() as {
      n: number;
    }
  ).n;
}

describe("sign-in racing a credential change", () => {
  it("a maintenance reset during verification defeats the old password", async () => {
    hasher.hold();
    const pending = auth.login("owner", OLD, "a");
    expect(hasher.verifyCalls).toBe(1);
    await auth.resetPassword("owner", RESET);
    hasher.release();
    await expect(pending).rejects.toThrow("Login name or password is incorrect");
    expect(sessionCount()).toBe(0);
    await expect(auth.login("owner", RESET, "a")).resolves.toBeDefined();
  });

  it("disabling the user during verification issues no session", async () => {
    hasher.hold();
    const pending = auth.login("owner", OLD, "a");
    auth.setUserDisabled("owner", true);
    hasher.release();
    await expect(pending).rejects.toThrow("Login name or password is incorrect");
    expect(sessionCount()).toBe(0);
  });

  it("a write from another process (the CLI) during verification also wins", async () => {
    hasher.hold();
    const pending = auth.login("owner", OLD, "a");
    // Another AuthService on the same database stands in for the CLI process.
    const cli = new AuthService(db, { liveSweepMs: 0 }, () => new Date(), {
      hasher: new GatedHasher(),
    });
    await cli.resetPassword("owner", RESET);
    hasher.release();
    await expect(pending).rejects.toThrow();
    expect(sessionCount()).toBe(0);
  });
});

describe("password change racing a reset or a logout", () => {
  async function signedIn() {
    const opened = await auth.login("owner", OLD, "a");
    const principal = auth.resolve(opened.token)?.principal;
    if (!principal) throw new Error("no principal");
    return { opened, principal };
  }

  it("a reset that completes first is not overwritten, and no session is issued", async () => {
    const { principal } = await signedIn();
    hasher.hold();
    const pending = auth.changePassword(principal, OLD, CHANGED);
    await auth.resetPassword("owner", RESET);
    hasher.release();
    await expect(pending).rejects.toThrow(/not signed in|changed elsewhere/);
    expect(sessionCount()).toBe(0);
    await expect(auth.login("owner", CHANGED, "b")).rejects.toThrow();
    await expect(auth.login("owner", RESET, "b")).resolves.toBeDefined();
  });

  it("a logout that completes first leaves the password as it was", async () => {
    const { principal } = await signedIn();
    hasher.hold();
    const pending = auth.changePassword(principal, OLD, CHANGED);
    auth.logout(principal.sessionId);
    hasher.release();
    await expect(pending).rejects.toThrow("not signed in");
    expect(sessionCount()).toBe(0);
    await expect(auth.login("owner", CHANGED, "b")).rejects.toThrow();
    await expect(auth.login("owner", OLD, "b")).resolves.toBeDefined();
  });

  it("a hash written by another process while the session stays valid is not overwritten", async () => {
    const { principal } = await signedIn();
    hasher.hold();
    const pending = auth.changePassword(principal, OLD, CHANGED);
    // A direct hash write that revokes nothing, so only the hash comparison can catch it.
    const login = auth.users.findLocalLogin("owner");
    auth.users.setPasswordHash(login?.id ?? "", await new PasswordHasher().hash(RESET));
    hasher.release();
    await expect(pending).rejects.toThrow("changed elsewhere");
    await expect(auth.login("owner", RESET, "b")).resolves.toBeDefined();
  });
});

describe("failure budget under concurrency", () => {
  it("refuses the sixth concurrent guess before verifying it", async () => {
    hasher.hold();
    // Each guess gets its rejection assertion as it starts: awaiting them one by one would leave
    // the later ones rejecting with no handler attached (an unhandled rejection under CI timing).
    const guesses = Array.from({ length: 5 }, (_, i) =>
      expect(auth.login("owner", `wrong guess ${i}!`, "a")).rejects.toThrow("incorrect"),
    );
    expect(hasher.verifyCalls).toBe(5);
    await expect(auth.login("owner", "wrong guess 5!", "a")).rejects.toThrow(
      "Too many failed sign-in attempts",
    );
    expect(hasher.verifyCalls).toBe(5);
    hasher.release();
    await Promise.all(guesses);
    // The window now holds five failures: the right password is refused too.
    await expect(auth.login("owner", OLD, "b")).rejects.toThrow("Too many failed sign-in attempts");
  });

  it("concurrent password-change guesses share the same reserved budget", async () => {
    const opened = await auth.login("owner", OLD, "a");
    const principal = auth.resolve(opened.token)?.principal;
    if (!principal) throw new Error("no principal");
    hasher.hold();
    const before = hasher.verifyCalls;
    const guesses = Array.from({ length: 5 }, (_, i) =>
      expect(auth.changePassword(principal, `wrong guess ${i}!`, CHANGED)).rejects.toThrow(
        "incorrect",
      ),
    );
    await expect(auth.changePassword(principal, OLD, CHANGED)).rejects.toThrow(
      "Too many failed attempts",
    );
    expect(hasher.verifyCalls - before).toBe(5);
    hasher.release();
    await Promise.all(guesses);
  });

  it("invalid input releases its reservation without clearing earlier failures", async () => {
    const opened = await auth.login("owner", OLD, "a");
    const principal = auth.resolve(opened.token)?.principal;
    if (!principal) throw new Error("no principal");
    for (let i = 0; i < 4; i++)
      await expect(auth.changePassword(principal, `wrong ${i} guess!!`, CHANGED)).rejects.toThrow();
    // A too-short new password is a validation error, not a success that resets the count.
    await expect(auth.changePassword(principal, OLD, "short")).rejects.toThrow("at least");
    await expect(auth.changePassword(principal, "wrong 5 guess!!", CHANGED)).rejects.toThrow(
      "incorrect",
    );
    await expect(auth.changePassword(principal, OLD, CHANGED)).rejects.toThrow(
      "Too many failed attempts",
    );
  });
});
