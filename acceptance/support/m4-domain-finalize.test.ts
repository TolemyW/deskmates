import { expect, it } from "vitest";
import { finalizeDomainAttempt } from "./m4-domain-finalize.js";

function fixture() {
  const calls: string[] = [];
  const saved: { name: string; data: unknown }[] = [];
  const step = (name: string, fails = false) => ({
    name,
    async run() {
      calls.push(name);
      if (fails) throw Error(`${name} failed`);
    },
  });
  return {
    calls,
    saved,
    step,
    options: {
      oraclePassed: true,
      evidence: [step("run"), step("data-state")],
      cleanup: [step("stack"), step("fixture")],
      save(name: string, data: unknown) {
        calls.push("save");
        saved.push({ name, data });
      },
    },
  };
}

it("writes a pass only after all evidence and cleanup callbacks, without claiming resource absence", async () => {
  const f = fixture();
  await finalizeDomainAttempt(f.options);
  expect(f.calls).toEqual(["run", "data-state", "stack", "fixture", "save"]);
  expect(f.saved).toEqual([
    {
      name: "verdict.json",
      data: {
        passed: true,
        oraclePassed: true,
        evidenceComplete: true,
        cleanupCallbacksCompleted: true,
        resourceAbsenceVerified: false,
        failures: [],
      },
    },
  ]);
});
it("retains evidence errors, continues other capture and cleanup, and fails closed", async () => {
  const f = fixture();
  f.options.evidence[0] = f.step("run", true);
  await expect(finalizeDomainAttempt(f.options)).rejects.toThrow(
    "domain evidence or cleanup failed",
  );
  expect(f.calls).toEqual(["run", "data-state", "stack", "fixture", "save"]);
  expect(f.saved[0]?.data).toMatchObject({
    passed: false,
    evidenceComplete: false,
    failures: [{ stage: "evidence", name: "run", error: "Error" }],
  });
});
it("attempts fixture cleanup after stack cleanup rejects and retains every failure", async () => {
  const f = fixture();
  f.options.cleanup = [f.step("stack", true), f.step("fixture", true)];
  await expect(finalizeDomainAttempt(f.options)).rejects.toThrow();
  expect(f.calls).toEqual(["run", "data-state", "stack", "fixture", "save"]);
  expect(f.saved[0]?.data).toMatchObject({
    passed: false,
    cleanupCallbacksCompleted: false,
    failures: [
      { stage: "cleanup", name: "stack" },
      { stage: "cleanup", name: "fixture" },
    ],
  });
});
it("does not turn an oracle failure into a pass when finalization succeeds", async () => {
  const f = fixture();
  f.options.oraclePassed = false;
  await finalizeDomainAttempt(f.options);
  expect(f.saved[0]?.data).toMatchObject({
    passed: false,
    oraclePassed: false,
    evidenceComplete: true,
  });
});
it("rejects a purported pass with no run evidence", async () => {
  const f = fixture();
  f.options.evidence = [];
  await expect(finalizeDomainAttempt(f.options)).rejects.toThrow("domain run evidence is missing");
  expect(f.saved[0]?.data).toMatchObject({ passed: false, evidenceComplete: false });
});
it("finishes cleanup even if verdict persistence itself fails", async () => {
  const f = fixture();
  f.options.save = () => {
    throw Error("disk full");
  };
  await expect(finalizeDomainAttempt(f.options)).rejects.toThrow("disk full");
  expect(f.calls).toEqual(["run", "data-state", "stack", "fixture"]);
});

it("never retains arbitrary exception text, names, argv, or non-Error values", async () => {
  const f = fixture();
  const secret = "synthetic-private-token";
  const error = new Error(`docker --env TOKEN=${secret}`);
  error.name = secret;
  f.options.evidence = [
    {
      name: "run",
      async run() {
        throw error;
      },
    },
  ];
  f.options.cleanup = [
    {
      name: "fixture",
      async run() {
        throw secret;
      },
    },
  ];
  await expect(finalizeDomainAttempt(f.options)).rejects.toThrow(
    "domain evidence or cleanup failed",
  );
  expect(JSON.stringify(f.saved)).not.toContain(secret);
  expect(f.saved[0]?.data).toMatchObject({
    failures: [
      { stage: "evidence", name: "run", error: "Error" },
      { stage: "cleanup", name: "fixture", error: "NonError" },
    ],
  });
});

it("does not substitute a passing state snapshot for missing run evidence", async () => {
  const f = fixture();
  f.options.evidence = [f.step("data-state")];
  await expect(finalizeDomainAttempt(f.options)).rejects.toThrow("domain run evidence is missing");
  expect(f.saved[0]?.data).toMatchObject({ passed: false, evidenceComplete: false });
});
