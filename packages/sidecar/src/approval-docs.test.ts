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
