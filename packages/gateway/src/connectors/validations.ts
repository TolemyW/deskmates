// Stored validations (ADR-0012 item 5): a connector's verdict on one content hash, bound to the
// run that asked and valid until `expiresAt`. The TTL is a knob recorded in `runs.config_json`.

import type {
  BotId,
  ConnectorEffect,
  ConnectorFieldError,
  ConnectorId,
  RunId,
  StoredConnectorValidation,
} from "@deskmates/contracts";
import { parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface ValidationRow {
  connector_id: string;
  validation_id: string;
  run_id: string;
  bot_id: string;
  content_hash: string;
  valid: number;
  effect: string;
  summary: string;
  errors_json: string;
  created_at: string;
  expires_at: string;
}

function toValidation(row: ValidationRow): StoredConnectorValidation {
  return {
    validationId: row.validation_id,
    connectorId: row.connector_id as ConnectorId,
    runId: row.run_id as RunId,
    botId: row.bot_id as BotId,
    contentHash: row.content_hash,
    valid: row.valid === 1,
    effect: row.effect as ConnectorEffect,
    summary: row.summary,
    errors: parseJson<ConnectorFieldError[]>(row.errors_json, []),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class ValidationStore {
  constructor(private readonly db: GatewayDb) {}

  record(v: StoredConnectorValidation): StoredConnectorValidation {
    this.db
      .prepare(
        `INSERT INTO connector_validations
           (connector_id, validation_id, run_id, bot_id, content_hash, valid, effect, summary,
            errors_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.connectorId,
        v.validationId,
        v.runId,
        v.botId,
        v.contentHash,
        v.valid ? 1 : 0,
        v.effect,
        v.summary,
        JSON.stringify(v.errors),
        v.createdAt,
        v.expiresAt,
      );
    return v;
  }

  get(connectorId: ConnectorId, validationId: string): StoredConnectorValidation | undefined {
    const row = this.db
      .prepare("SELECT * FROM connector_validations WHERE connector_id = ? AND validation_id = ?")
      .get(connectorId, validationId) as ValidationRow | undefined;
    return row ? toValidation(row) : undefined;
  }

  /**
   * Other connectors of the same workspace that hold this validation id, for the typed refusal
   * of a submit on the wrong connector. Other workspaces are not searched.
   */
  otherConnectorsWith(connectorId: ConnectorId, validationId: string): ConnectorId[] {
    return (
      this.db
        .prepare(
          `SELECT v.connector_id FROM connector_validations v
             JOIN connectors c ON c.id = v.connector_id
            WHERE v.validation_id = ? AND v.connector_id != ?
              AND c.workspace_id = (SELECT workspace_id FROM connectors WHERE id = ?)`,
        )
        .all(validationId, connectorId, connectorId) as { connector_id: string }[]
    ).map((r) => r.connector_id as ConnectorId);
  }
}
