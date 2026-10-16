// T0: the run's story is derived from the ledger alone. A thought opens a segment; the tool
// calls, approvals, screenshots and model trouble that follow are its steps; telemetry is left
// to the technical log. Tool names become plain verbs with the command, path or URL as object.

import { describe, expect, it } from "vitest";
import { runEvent } from "../../test-support/fixtures.js";
import { describeTool, firstLine, storyOf, thoughtHeading } from "./run-story.js";

describe("storyOf", () => {
  it("groups steps under the thought that preceded them and skips telemetry", () => {
    const segments = storyOf([
      runEvent(1, "thinking", { text: "First I check the queue.\nThen I answer." }),
      runEvent(2, "turn_usage", { turn: 1, model: "m", inputTokens: 1, outputTokens: 1 }),
      runEvent(3, "tool_call", {
        toolUseId: "tu_1",
        toolName: "Bash",
        riskLevel: "L1",
        input: { command: "ls -la /work" },
      }),
      runEvent(4, "tool_result", { toolUseId: "tu_1", content: "ok", isError: false }),
      runEvent(5, "compact_boundary", { trigger: "auto", preTokens: 10 }),
      runEvent(6, "thinking", { text: "Now the ticket page" }),
      runEvent(7, "tool_call", {
        toolUseId: "tu_2",
        toolName: "mcp__browser__browser_navigate",
        riskLevel: "L0",
        input: { url: "https://ops.example.test/tickets/" },
      }),
      runEvent(8, "tool_result", { toolUseId: "tu_2", content: "page", isError: false }),
      runEvent(9, "screenshot", { dataUrl: "data:image/png;base64,AAAA", caption: "tickets" }),
      runEvent(10, "log", { source: "memory", op: "index", level: "info" }),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.thought).toMatchObject({
      heading: "First I check the queue.",
      truncated: true,
    });
    expect(segments[0]?.steps.map((s) => [s.verb, s.object, s.tone])).toEqual([
      ["runStory.verb.ran", "ls -la /work", "done"],
    ]);
    expect(segments[1]?.thought).toMatchObject({
      heading: "Now the ticket page",
      truncated: false,
    });
    const opened = segments[1]?.steps[0];
    expect(opened).toMatchObject({
      verb: "runStory.verb.opened",
      object: "ops.example.test/tickets",
      tone: "done",
    });
    // The screenshot right after a browser step belongs to that step, not to a step of its own.
    expect(opened?.screenshot).toMatchObject({ caption: "tickets" });
    expect(segments[1]?.steps).toHaveLength(1);
  });

  it("starts without a thought, marks the open call as now and the failed one as an error", () => {
    const segments = storyOf([
      runEvent(1, "tool_call", {
        toolUseId: "tu_1",
        toolName: "Read",
        riskLevel: "L0",
        input: { file_path: "/work/notes.md" },
      }),
      runEvent(2, "tool_result", { toolUseId: "tu_1", content: "nope", isError: true }),
      runEvent(3, "tool_call", {
        toolUseId: "tu_2",
        toolName: "Bash",
        riskLevel: "L1",
        input: { command: "sleep 30" },
      }),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.thought).toBeUndefined();
    expect(segments[0]?.steps.map((s) => [s.tone, s.tool?.open])).toEqual([
      ["error", false],
      ["now", true],
    ]);
  });

  it("folds model retries and the switch they led to into one step, in ledger order", () => {
    const segments = storyOf([
      runEvent(1, "model_retry", { attempt: 1, maxRetries: 10, errorStatus: 529 }),
      runEvent(2, "model_retry", { attempt: 2, maxRetries: 10, errorStatus: 529 }),
      runEvent(3, "model_switch", { from: "big", to: "small", source: "auto" }),
      runEvent(4, "tool_call", { toolUseId: "tu_1", toolName: "LS", riskLevel: "L0", input: {} }),
      runEvent(5, "model_retry", { attempt: 1, maxRetries: 10, errorStatus: 500 }),
    ]);
    expect(segments[0]?.steps.map((s) => [s.seq, s.verb, s.values])).toEqual([
      [1, "runStory.verb.modelRetriedThenSwitched", { retries: 2, model: "small" }],
      [4, "runStory.verb.listed", undefined],
      [5, "runStory.verb.modelRetried", { retries: 1 }],
    ]);
  });

  it("reads approvals, takeovers, stalls, caps and the bot's own log lines as steps", () => {
    const segments = storyOf([
      runEvent(1, "approval", {
        phase: "posted",
        toolName: "Bash",
        riskLevel: "L2",
        argumentSummary: "git push origin main",
      }),
      runEvent(2, "approval", { phase: "reminded", approvalId: "a1" }),
      runEvent(3, "approval", { phase: "decided", decision: "allow", decidedBy: "alice" }),
      runEvent(4, "takeover", { phase: "taken", by: "bob" }),
      runEvent(5, "log", { source: "stall", op: "stalled", idleMs: 300_000, stallSeconds: 300 }),
      runEvent(6, "cap_breached", { cap: "relay_count", limit: 5 }),
      runEvent(7, "log", { source: "assistant", text: "all green" }),
      runEvent(8, "skill_used", { skill: "triage" }),
    ]);
    expect(segments[0]?.steps.map((s) => [s.verb, s.object ?? s.text, s.tone])).toEqual([
      ["runStory.verb.askedApproval", "git push origin main", "warn"],
      ["runStory.verb.approvalAllowed", undefined, "done"],
      ["runStory.verb.humanTookOver", undefined, "info"],
      ["runStory.verb.stalled", undefined, "warn"],
      ["runStory.verb.capReached", "relay_count", "warn"],
      ["runStory.verb.said", "all green", "info"],
      ["runStory.verb.usedSkill", "triage", "done"],
    ]);
    expect(segments[0]?.steps[0]?.values).toEqual({ tool: "Bash" });
    expect(segments[0]?.steps[3]?.values).toEqual({ idleMs: 300_000 });
  });
});

describe("describeTool", () => {
  it.each([
    ["Write", { file_path: "/work/a.md" }, "runStory.verb.wrote", "/work/a.md"],
    ["Grep", { pattern: "TODO", path: "/work" }, "runStory.verb.searchedFiles", "TODO"],
    [
      "mcp__browser__browser_click",
      { element: "Save button" },
      "runStory.verb.clicked",
      "Save button",
    ],
    // The typed text may be a secret: the field is named, the text is not.
    [
      "mcp__browser__browser_type",
      { element: "Password", text: "hunter2" },
      "runStory.verb.typed",
      "Password",
    ],
    ["mcp__browser__browser_snapshot", {}, "runStory.verb.lookedAtPage", undefined],
    ["mcp__browser__browser_cookie_list", {}, "runStory.verb.usedBrowser", "cookie_list"],
    [
      "mcp__deskmates__thread_post",
      { body: "Done.\nDetails below." },
      "runStory.verb.posted",
      "Done.\nDetails below.",
    ],
    ["mcp__deskmates__connector_submit", { connector: "pg" }, "runStory.verb.usedConnector", "pg"],
    ["mcp__other__frobnicate", {}, "runStory.verb.usedTool", "frobnicate"],
  ])("%s", (name, input, verb, object) => {
    expect(describeTool(name, input)).toEqual(object === undefined ? { verb } : { verb, object });
  });
});

describe("firstLine and thoughtHeading", () => {
  it("bounds a long command on a word boundary and marks the cut", () => {
    const long = `echo ${"word ".repeat(40)}`;
    const line = firstLine(long);
    expect(line.truncated).toBe(true);
    expect(line.text.length).toBeLessThanOrEqual(120);
    expect(line.text.endsWith("…")).toBe(true);
    expect(firstLine("  short  ")).toEqual({ text: "short", truncated: false });
  });

  it("heads a segment with the thought's first sentence, Chinese punctuation included", () => {
    expect(thoughtHeading("需要先确认目录。然后再回复。")).toEqual({
      text: "需要先确认目录。",
      truncated: true,
    });
    expect(thoughtHeading("One line only")).toEqual({ text: "One line only", truncated: false });
  });
});
