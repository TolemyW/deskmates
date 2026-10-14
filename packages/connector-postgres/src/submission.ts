// The submission this connector executes: one batch of cases, each case a list of SQL steps run
// in order on one connection. The shape is the batch of the VendorDB campaigns' host adapter
// without its campaign-specific rules
// (batch id pattern, table prefix, regression file paths), which belong to the task, not the
// connector.

import type { ConnectorJsonSchema } from "@deskmates/contracts";

export interface SqlCase {
  id: string;
  /** Where the case comes from, e.g. `postgres/src/test/regress/sql/with.sql`. */
  source: string;
  source_lines?: string;
  expected_source?: string;
  /** What was changed from the source and what outcome is expected. */
  adaptation: string;
  steps: string[];
}

export interface SqlBatch {
  batch_id: string;
  cases: SqlCase[];
}

export const SUBMISSION_SCHEMA: ConnectorJsonSchema = {
  type: "object",
  description: "One batch: cases run in order, each on its own connection, steps in order.",
  required: ["batch_id", "cases"],
  additionalProperties: false,
  properties: {
    batch_id: { type: "string", description: "Caller-chosen batch name, non-empty." },
    cases: {
      type: "array",
      description: "One or more cases, up to the casesPerBatch limit; ids unique in the batch.",
      items: {
        type: "object",
        required: ["id", "source", "adaptation", "steps"],
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Case id, non-empty, unique in the batch." },
          source: { type: "string", description: "Where the case comes from." },
          source_lines: { type: "string", description: "The source lines the case cites." },
          expected_source: { type: "string", description: "Where the expected output is." },
          adaptation: {
            type: "string",
            description: "What changed from the source and the expected outcome.",
          },
          steps: {
            type: "array",
            description: "One SQL statement per step, run in order in autocommit mode.",
            items: { type: "string" },
          },
        },
      },
    },
  },
};
