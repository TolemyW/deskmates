// T0: ADR-0022 decision 2 / test plan AUTH-02. Local passwords are Argon2id with recorded
// parameters, and verification never throws on a malformed or foreign hash.

import { describe, expect, it } from "vitest";
import {
  ARGON2_DEFAULTS,
  PASSWORD_MIN_LENGTH,
  PasswordHasher,
  generateInitialPassword,
  passwordProblem,
} from "./passwords.js";

describe("initial passwords (ADR-0022 amendment 4 I4)", () => {
  it("are long, unambiguous, distinct and at least the configured minimum", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const password = generateInitialPassword();
      expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){4}$/);
      expect(passwordProblem(password)).toBeUndefined();
      seen.add(password);
    }
    expect(seen.size).toBe(200);
    expect(generateInitialPassword(40).length).toBeGreaterThanOrEqual(40);
  });
});

describe("password hashing", () => {
  it("stores Argon2id with the configured parameters in the PHC string", async () => {
    const hasher = new PasswordHasher();
    const hash = await hasher.hash("correct horse battery staple");
    expect(hash.startsWith("$argon2id$v=19$")).toBe(true);
    expect(hash).toContain(
      `m=${ARGON2_DEFAULTS.memoryKiB},t=${ARGON2_DEFAULTS.iterations},p=${ARGON2_DEFAULTS.parallelism}`,
    );
    expect(ARGON2_DEFAULTS).toEqual({ memoryKiB: 19_456, iterations: 2, parallelism: 1 });
    expect(hash).not.toContain("correct horse");
  });

  it("accepts the right password only, and fails closed on foreign or broken hashes", async () => {
    const hasher = new PasswordHasher({ memoryKiB: 1024, iterations: 1, parallelism: 1 });
    const hash = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify(hash, "correct horse battery staple")).toBe(true);
    expect(await hasher.verify(hash, "correct horse battery stapl")).toBe(false);
    expect(await hasher.verify("$argon2id$garbage", "x")).toBe(false);
    expect(await hasher.verify("$2b$10$abcdefghijklmnopqrstuv", "x")).toBe(false);
    expect(await hasher.verify("plaintext", "plaintext")).toBe(false);
    expect(await hasher.verifyAgainstNothing("anything")).toBe(false);
  });

  it("bounds password length before hashing", () => {
    expect(passwordProblem("x".repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
    expect(passwordProblem("x".repeat(PASSWORD_MIN_LENGTH))).toBeUndefined();
    expect(passwordProblem("x".repeat(1025))).toMatch(/at most/);
  });

  it("takes the minimum from configuration and keeps the maximum fixed", () => {
    expect(passwordProblem("admin", 5)).toBeUndefined();
    expect(passwordProblem("admi", 5)).toMatch(/at least 5 characters/);
    expect(passwordProblem("x".repeat(1025), 5)).toMatch(/at most/);
    expect(PASSWORD_MIN_LENGTH).toBe(12);
  });
});
