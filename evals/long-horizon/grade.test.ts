import { readFileSync } from "node:fs";
import { GoldenSiteState } from "@deskmates/golden-site";
import { describe, expect, it } from "vitest";
import { type GradeInput, grade } from "./grade.js";
import { parseMission } from "./mission.js";

const mission = parseMission(
  readFileSync(new URL("./missions/l01-single.json", import.meta.url), "utf8"),
);
function reference(): GradeInput {
  const state = new GoldenSiteState();
  const seed = structuredClone(state.view());
  for (const id of mission.expected.tickets) {
    state.commentOnTicket(id, "Overdue", "reference");
    state.closeTicket(id, "reference");
  }
  return {
    mission,
    seed,
    asOf: new Date().toISOString(),
    after: state.view(),
    log: [...state.opLog()],
    phaseLogStart: 0,
    files: {},
  };
}

describe("long-horizon independent oracle", () => {
  it("passes complete reference state without a model answer", () => {
    const input = reference();
    expect(mission.final.map((o) => grade(o, input).status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });
  it.each(["missing", "duplicate", "inverted", "collateral"])(
    "rejects %s effect with a claimed successful run",
    (kind) => {
      const g = reference();
      g.run = { status: "succeeded", attempt: 1, reply: "answer: 6" };
      if (kind === "missing") g.after?.tickets["1003"]?.comments.pop();
      if (kind === "duplicate") g.after?.tickets["1003"]?.comments.push("Overdue");
      if (kind === "inverted") {
        const first = g.log?.find((e) => e.op === "ticket_comment");
        if (first) first.op = "ticket_close";
      }
      if (kind === "collateral" && g.after?.tickets["1004"])
        g.after.tickets["1004"].status = "closed";
      expect(mission.final.map((o) => grade(o, g).status)).toContain("fail");
    },
  );
  it("keeps absent state, log and failed file observation unknown", () => {
    const g = { mission, phaseLogStart: 0, files: {} };
    expect(mission.final.map((o) => grade(o, g).status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
    const oracle = {
      name: "file",
      type: "file_regex_count",
      path: "/work/plan.md",
      regex: "x",
      op: "eq",
      value: 1,
    } as const;
    expect(grade(oracle, g).status).toBe("unknown");
    expect(grade(oracle, { ...g, files: { "/work/plan.md": null } }).status).toBe("fail");
  });
  it("compares only this phase's mutations", () => {
    const g = reference();
    expect(
      grade(
        { name: "read-only phase", type: "phase_mutations", op: "eq", value: 0 },
        { ...g, phaseLogStart: g.log?.length ?? 0 },
      ).status,
    ).toBe("pass");
  });
  it("refuses a changed eligible seed even if the declared six tickets were completed", () => {
    const g = reference();
    const ticket = g.seed?.tickets["1022"];
    if (!ticket) throw new Error("seed ticket missing");
    ticket.status = "open";
    ticket.created_at = new Date(Date.parse(g.asOf ?? "") - 45 * 86400_000).toISOString();
    expect(grade({ name: "eligible seed", type: "eligible_tickets" }, g).status).toBe("fail");
  });
  it("does not let ticket ids become regex operators", () => {
    const g = reference();
    g.mission = { ...mission, expected: { tickets: ["1.3"] } };
    const o = {
      name: "id",
      type: "file_regex_count",
      path: "/work/plan",
      regex: "^{tickets} pending$",
      op: "eq",
      value: 1,
    } as const;
    expect(grade(o, { ...g, files: { "/work/plan": "123 pending" } }).status).toBe("fail");
    expect(grade(o, { ...g, files: { "/work/plan": "1.3 pending" } }).status).toBe("pass");
  });
});
