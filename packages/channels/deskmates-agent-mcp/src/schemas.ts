// JSON Schema fragments shared by the MCP tool input schemas and the OpenAPI document, so the
// two never describe the same field differently.

import { EXTERNAL_REF_MAX_LENGTH, TASK_STATUSES } from "@deskmates/contracts";

export type JsonSchema = { [key: string]: unknown };

/** The decisions `POST /api/approvals/:id/decide` accepts (contracts `ApprovalDecision`). */
export const APPROVAL_DECISIONS = ["allow_once", "allow_always", "deny"] as const;

export const ID: JsonSchema = { type: "string", minLength: 1 };

export const WORKSPACE_ID: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Workspace id. Optional when the server was started with DESKMATES_WORKSPACE_ID.",
};

export const EXTERNAL_KEY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: EXTERNAL_REF_MAX_LENGTH,
  description:
    "Your own id for this unit of work, unique per workspace. A repeat submit with the same key returns the existing thread, task and runs instead of creating new ones.",
};

export const TASK_STATUS: JsonSchema = { type: "string", enum: [...TASK_STATUSES] };

export const OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Optional JSON Schema the bot's delivered output must satisfy (subset: type, required, properties, enum, items, additionalProperties, title, description).",
};

export const DEADLINE: JsonSchema = {
  type: "string",
  format: "date-time",
  description:
    "Optional ISO 8601 date-time with a zone, in the future (a past deadline is refused). Past it the scheduler cancels the thread's unfinished runs with reason `deadline`.",
};

export const DECISION: JsonSchema = {
  type: "string",
  enum: [...APPROVAL_DECISIONS],
  description:
    "allow_once lets this one call proceed; allow_always also stores a rule for the bot that answers matching calls without asking; deny refuses it.",
};

/** Most attachments the Gateway accepts on one submit instruction. */
export const SUBMIT_ATTACHMENTS_MAX = 20;

export const ATTACHMENTS: JsonSchema = {
  type: "array",
  maxItems: SUBMIT_ATTACHMENTS_MAX,
  description:
    "Optional inputs attached to the instruction message: a workspace path or a Gateway artifact URL each. Names inputs; does not upload them.",
  items: {
    type: "object",
    required: ["name", "mimeType", "ref"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      mimeType: { type: "string", minLength: 1 },
      ref: { type: "string", minLength: 1, description: "Workspace path or artifact URL" },
    },
  },
};

/** The body of `POST /api/workspaces/:id/submit` (contracts `SubmitRequest`, issue #21). */
export const SUBMIT_BODY: JsonSchema = {
  type: "object",
  required: ["externalKey", "botId", "title", "instruction"],
  additionalProperties: false,
  properties: {
    externalKey: EXTERNAL_KEY,
    botId: { ...ID, description: "The bot that does the work (see list_bots)." },
    title: { type: "string", minLength: 1, description: "Thread and task title." },
    instruction: {
      type: "string",
      minLength: 1,
      description:
        "What the bot should do. Posted as one must-reply message: a run that ends without replying is recorded failed with reason `no_reply`.",
    },
    description: { type: "string", description: "Optional longer task description." },
    outputSchema: OUTPUT_SCHEMA,
    deadline: DEADLINE,
    attachments: ATTACHMENTS,
  },
};
