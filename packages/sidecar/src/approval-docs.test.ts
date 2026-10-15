// T0: who may decide an approval is a documented property, not only code (ADR-0002 amendment 2,
// verification row A2: "T0 static grep that packages/sidecar/README.md and AGENTS.md carry the
// soft-boundary sentence"). A deciding bot must never be described as a security boundary; that
// claim is the one ADR-0004 forbids.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTENCE = "a deciding bot is a soft boundary";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the soft-boundary sentence is in the docs an agent reads", () => {
  it.each([
    ["packages/sidecar/README.md", "../README.md"],
    ["AGENTS.md", "../../../AGENTS.md"],
  ])("%s says a deciding bot is a soft boundary", (_name, relative) => {
    expect(read(relative)).toContain(SENTENCE);
  });
});

// ADR-0002 amendment 6: the L2 rule an agent reads names the workspace approval mode, what stays
// with a human in `automatic`, and that no mode touches the hard denies (test strategy §11).
describe("the approval mode is in the AGENTS.md risk-tier rule", () => {
  it("names the three modes, the human-only classes and the unchanged hard denies", () => {
    const rule = read("../../../AGENTS.md").replace(/\s+/g, " ");
    for (const phrase of [
      "the workspace's approval mode decides who answers (ADR-0002 amendment 6)",
      "`manual` asks the thread",
      "`automatic`, the default for a new workspace",
      "deletion, permission expansion, egress asks, credential-bearing and unclassified actions still go to a human",
      "`approve_all` allows every gated action without asking anyone",
      "recorded as decided by `mode:approve_all`",
      "No mode touches the hard denies",
    ])
      expect(rule).toContain(phrase);
  });
});

// ADR-0012 item 6: a connector approval shows the proposed action, never the submission body,
// matching ADR-0002's "proposed action, never page content". The behaviour is tested in
// `connector-tools.test.ts`; this keeps the rule written where an agent reads it.
describe("the connector approval rule is in the sidecar README", () => {
  it("says what a connector approval request carries and what it never carries", () => {
    expect(read("../README.md")).toContain(
      "carries the connector id, the content hash and the validation summary,\nnever the submission body",
    );
  });
});

// ADR-0013 Amendment 2: Drive adds a redacted proposal preview. Behaviour in
// `integration-tools.test.ts`; this keeps the rule written where an agent reads it.
describe("the integration approval rule is in the sidecar README", () => {
  it("says what an integration approval request carries and what it never carries", () => {
    const readme = read("../README.md").replace(/\s+/g, " ");
    expect(readme).toContain(
      "For Drive it also carries a bounded, redacted proposed target and outgoing content preview (ADR-0013 Amendment 2); other providers omit the input body.",
    );
  });
});
