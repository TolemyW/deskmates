// T0: the profile editor's pure half. Rows round-trip to the Gateway's rule shape and back,
// expiry choices become instants, and a bad row or bad JSON is refused with the Gateway's words.

import type { NetworkProfile } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  type RuleDraft,
  draftOf,
  expiresAtOf,
  fromLocalInput,
  inputOf,
  rawRulesOf,
  ruleDraftOf,
  toLocalInput,
} from "./profile-form.js";

const profile: NetworkProfile = {
  id: "netp_1",
  name: "VendorDB test environment",
  description: "the test box",
  rules: [
    { kind: "subnet", cidr: "10.88.30.0/24", schemes: ["http"], ports: [23001] },
    {
      kind: "host",
      hostname: "console.lab.test",
      address: "10.0.0.5",
      schemes: ["http", "https"],
      ports: [443, 8443],
    },
  ],
  revision: 3,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  updatedBy: "user:root",
};

describe("draftOf and inputOf", () => {
  it("round-trips a profile's rules through rows", () => {
    const draft = draftOf(profile);
    expect(draft.rules.map((r) => [r.kind, r.http, r.https, r.ports])).toEqual([
      ["subnet", true, false, "23001"],
      ["host", true, true, "443, 8443"],
    ]);
    expect(draft.expiry).toEqual({ mode: "never", at: "" });
    expect(inputOf(draft, undefined)).toEqual({
      name: profile.name,
      description: profile.description,
      rules: profile.rules,
    });
  });

  it("reads ports as typed, in any separator, and lets the Gateway's parser judge the rest", () => {
    const [row] = draftOf(profile).rules;
    expect(rawRulesOf([{ ...(row as RuleDraft), ports: " 80;443 8080, 1" }])).toEqual([
      { kind: "subnet", cidr: "10.88.30.0/24", schemes: ["http"], ports: [80, 443, 8080, 1] },
    ]);
    const bad = { ...draftOf(profile), rules: [{ ...(row as RuleDraft), cidr: "8.8.8.0/24" }] };
    expect(() => inputOf(bad, undefined)).toThrow(/RFC1918/);
  });

  it("takes the advanced JSON instead of the rows, and names bad JSON", () => {
    const draft = draftOf(profile);
    const json = JSON.stringify([profile.rules[1]]);
    expect(inputOf(draft, json).rules).toEqual([profile.rules[1]]);
    expect(() => inputOf(draft, "{nope")).toThrow();
    expect(() => inputOf(draft, '{"kind":"subnet"}')).toThrow(/list/);
  });

  it("turns the expiry choice into an instant, or none", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(expiresAtOf({ mode: "never", at: "" }, now)).toBeUndefined();
    expect(expiresAtOf({ mode: "day", at: "" }, now)).toBe("2026-10-17T12:00:00.000Z");
    expect(expiresAtOf({ mode: "week", at: "" }, now)).toBe("2026-10-23T12:00:00.000Z");
    const local = toLocalInput("2026-10-20T03:30:00Z");
    expect(expiresAtOf({ mode: "at", at: local }, now)).toBe("2026-10-20T03:30:00.000Z");
    expect(() =>
      inputOf({ ...draftOf(profile), expiry: { mode: "at", at: "" } }, undefined),
    ).toThrow(/date and time/);
  });

  it("opens an expiring profile on its date and reads a blank date as none", () => {
    const expiring = { ...profile, expiresAt: "2026-10-20T03:30:00Z" };
    const draft = draftOf(expiring);
    expect(draft.expiry.mode).toBe("at");
    expect(fromLocalInput(draft.expiry.at)).toBe("2026-10-20T03:30:00.000Z");
    expect(fromLocalInput("  ")).toBeUndefined();
    expect(ruleDraftOf(profile.rules[0] as NetworkProfile["rules"][number]).cidr).toBe(
      "10.88.30.0/24",
    );
  });
});
