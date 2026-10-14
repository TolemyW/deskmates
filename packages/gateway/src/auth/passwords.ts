// Local password hashing (ADR-0022 decision 2). Argon2id through the maintained `argon2`
// binding; the parameters are deployment configuration so an operator can calibrate them on the
// host, and every stored hash carries its own parameters in the PHC string.

import { randomInt } from "node:crypto";
import argon2 from "argon2";

/** Letters and digits without look-alikes (0/O, 1/l/I), for passwords a person retypes. */
const INITIAL_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * An initial password for an account an Admin creates (ADR-0022 amendment 4 I4): groups of four
 * symbols from a 57-symbol alphabet joined by `-`, drawn with the OS random source. Five groups
 * (about 116 bits) unless the configured minimum length needs more.
 */
export function generateInitialPassword(minLength: number = PASSWORD_MIN_LENGTH): string {
  const groups = Math.max(5, Math.ceil((minLength + 1) / 5));
  const parts: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    let part = "";
    for (let i = 0; i < 4; i += 1)
      part += INITIAL_PASSWORD_ALPHABET[randomInt(INITIAL_PASSWORD_ALPHABET.length)];
    parts.push(part);
  }
  return parts.join("-");
}

export interface Argon2Params {
  /** Memory cost in KiB. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet's Argon2id baseline (m=19 MiB, t=2, p=1). */
export const ARGON2_DEFAULTS: Readonly<Argon2Params> = {
  memoryKiB: 19_456,
  iterations: 2,
  parallelism: 1,
};

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

/**
 * Reject a password before hashing it; the bounds keep hashing cost predictable. The minimum is
 * deployment configuration (`GATEWAY_PASSWORD_MIN_LENGTH`, default 12) so a trial instance can
 * use short fixed passwords; the maximum is fixed.
 */
export function passwordProblem(
  password: string,
  minLength: number = PASSWORD_MIN_LENGTH,
): string | undefined {
  if (password.length < minLength) return `password must be at least ${minLength} characters`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return undefined;
}

export class PasswordHasher {
  private dummy: Promise<string> | undefined;

  constructor(private readonly params: Argon2Params = ARGON2_DEFAULTS) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.params.memoryKiB,
      timeCost: this.params.iterations,
      parallelism: this.params.parallelism,
    });
  }

  /** False for a wrong password and for a malformed or non-Argon2id hash; never throws. */
  async verify(hash: string, password: string): Promise<boolean> {
    if (!hash.startsWith("$argon2id$")) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spend the same work as a real verification when the login name is unknown, so response time
   * does not reveal which login names exist.
   */
  async verifyAgainstNothing(password: string): Promise<false> {
    this.dummy ??= this.hash("deskmates-no-such-user-dummy-password");
    await this.verify(await this.dummy, password);
    return false;
  }
}
