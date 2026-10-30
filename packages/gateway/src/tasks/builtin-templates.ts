// The first built-in task templates (ADR-0021 amendment 4, A4b), chosen by the coordinator under
// the owner's delegation of 2026-10-18 (issue #3 E1). Their contents are a strategy change that
// has not been evaluated (A4j): the numbers (10 sources, 24 hours) are starting guesses. They are
// read-only in every workspace; an Admin copies one to change it.

import type { TaskTemplate, TaskTemplateField, TaskTemplateStage } from "@deskmates/contracts";

/** The id prefix of a built-in template: `builtin:<kind>`. */
export const BUILTIN_PREFIX = "builtin:";

function stage(
  key: string,
  name: string,
  criteria: string[],
  checkpointRequired = false,
): TaskTemplateStage {
  return {
    key,
    name,
    checkpointRequired,
    criteria: criteria.map((text, i) => ({ label: `${key}.${i + 1}`, text })),
  };
}

function field(
  key: string,
  label: string,
  opts: { required?: boolean; defaultValue?: string; relates?: boolean } = {},
): TaskTemplateField {
  return {
    key,
    label,
    required: opts.required ?? false,
    defaultValue: opts.defaultValue ?? "",
    relates: opts.relates ?? false,
  };
}

function builtin(
  t: Pick<TaskTemplate, "kind" | "name" | "description" | "stages" | "review" | "slaMinutes"> & {
    fields: TaskTemplateField[];
  },
): TaskTemplate {
  return {
    ...t,
    id: `${BUILTIN_PREFIX}${t.kind}`,
    builtIn: true,
    version: 1,
    archivedAt: null,
    createdAt: null,
    updatedAt: null,
  };
}

export const BUILTIN_TEMPLATES: readonly TaskTemplate[] = [
  builtin({
    kind: "support-ticket",
    name: "Customer support ticket",
    description:
      "One customer request for a web product: understand it, resolve or escalate it, and confirm the outcome with the customer.",
    stages: [
      stage(
        "triage",
        "Triage",
        [
          "Customer, channel and priority are recorded, and the request is restated in one sentence.",
          "The issue is reproduced or classified (bug, question, account, billing), with the evidence.",
        ],
        true,
      ),
      stage(
        "resolve",
        "Resolve",
        [
          "A fix, answer or workaround is prepared and checked against the original request.",
          "When policy, access or a refund decision needs a person, the ticket is escalated with the reason instead of guessed.",
        ],
        true,
      ),
      stage("confirm", "Confirm", [
        "The reply to the customer is sent, or drafted for approval when sending needs one.",
        "The customer's confirmation, or a closing note saying why the ticket is closed, is recorded.",
      ]),
    ],
    review: "human",
    slaMinutes: 24 * 60,
    fields: [
      field("customer", "Customer", { required: true, relates: true }),
      field("channel", "Channel", { defaultValue: "web" }),
      field("priority", "Priority", { defaultValue: "P3" }),
    ],
  }),
  builtin({
    kind: "research-report",
    name: "Research report",
    description:
      "A report built from logged discovery, not from memory: sources first, then a draft that cites them, then an independent review.",
    stages: [
      stage(
        "discovery",
        "Discovery",
        [
          "At least 10 distinct sources are logged in a sources file, each with its URL or reference, title and access date.",
          "The search queries that found them are logged alongside.",
        ],
        true,
      ),
      stage("draft", "Draft", [
        "Every factual claim in the draft cites a logged source.",
        "Gaps the sources could not answer are stated as gaps, not filled from memory.",
      ]),
      stage(
        "peer-review",
        "Peer review",
        [
          "A teammate who did not write the draft reviewed it against the sources.",
          "Every review finding is resolved or recorded as open.",
        ],
        true,
      ),
      stage("deliver", "Deliver", [
        "The final report is delivered together with its sources file.",
      ]),
    ],
    review: "peer_bot",
    slaMinutes: null,
    fields: [field("audience", "Audience")],
  }),
  builtin({
    kind: "coding-task",
    name: "Coding task",
    description:
      "A change to a code base: plan it, implement it on its own branch, prove it with tests, have it reviewed, then deliver it.",
    stages: [
      stage("plan", "Plan", [
        "A plan names the scope, the files to change and how the change will be tested.",
      ]),
      stage("implement", "Implement", ["The change is implemented on its own branch or worktree."]),
      stage(
        "tests",
        "Tests pass",
        [
          "The test suite passes; the command run and its output are the evidence.",
          "New behaviour has a test that fails without the change.",
        ],
        true,
      ),
      stage(
        "review",
        "Review",
        ["A teammate reviewed the diff.", "Every review finding is resolved or recorded as open."],
        true,
      ),
      stage("deliver", "Deliver", ["Delivered with the branch or commit and the test evidence."]),
    ],
    review: "peer_bot",
    slaMinutes: null,
    fields: [field("repository", "Repository", { relates: true }), field("branch", "Branch")],
  }),
  builtin({
    kind: "functional-test",
    name: "Functional test",
    description:
      "Testing a product's behaviour: design the cases before running them, execute each with evidence, and report per case.",
    stages: [
      stage("plan-cases", "Plan cases", [
        "Test cases are listed before execution, each with its steps and expected result.",
      ]),
      stage(
        "execute",
        "Execute",
        [
          "Every case is executed with evidence (a screenshot, log or output) per case.",
          "No case is marked passed without its evidence.",
        ],
        true,
      ),
      stage("report", "Report", [
        "The report lists pass, fail and blocked per case, with the evidence paths.",
      ]),
    ],
    review: "human",
    slaMinutes: null,
    fields: [
      field("target", "Product or system under test", { relates: true }),
      field("environment", "Environment"),
    ],
  }),
];

export function builtinTemplate(id: string): TaskTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

export function isBuiltinKind(kind: string): boolean {
  return BUILTIN_TEMPLATES.some((t) => t.kind === kind);
}
