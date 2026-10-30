// What of a ledger event's payload body reaches a sink (ADR-0046 decision 2). The ledger has
// already redacted it; this only decides how much of it leaves.
//
// - `derived`: no payload body at all; the derived columns and the body's size still go.
// - `full`: the body, with a screenshot reduced to its size (no image bytes) and anything larger
//   than `OBSERVABILITY_PAYLOAD_MAX_BYTES` replaced by a JSON object that keeps the start of the
//   text and the original size, so `payload_json` is always valid JSON for a dashboard's
//   JSON-field macro.
//
// A run in a private chat is always treated as `derived`: a private chat is its person's alone,
// whatever anyone's role (ADR-0022 amendment 6, AGENTS.md), and Grafana is not that person.

import {
  OBSERVABILITY_PAYLOAD_MAX_BYTES,
  type ObservabilityPayloadPolicy,
} from "@deskmates/contracts";

export interface ShapedPayload {
  json: string | null;
  bytes: number;
  truncated: 0 | 1;
}

/** Screenshot fields that hold image bytes; everything else in the payload is small. */
const IMAGE_FIELDS = ["base64", "data"] as const;

/** The SQL expression that reads a payload without a screenshot's image bytes. */
export const PAYLOAD_SQL = `CASE WHEN e.kind = 'screenshot'
  THEN json_remove(e.payload_json, ${IMAGE_FIELDS.map((f) => `'$.${f}'`).join(", ")})
  ELSE e.payload_json END`;

function truncated(text: string, bytes: number): string {
  // The wrapper's own keys and escaping take some of the budget; shrink the head until it fits.
  let head = text.slice(0, OBSERVABILITY_PAYLOAD_MAX_BYTES);
  for (;;) {
    const wrapped = JSON.stringify({ _truncated: true, _bytes: bytes, _head: head });
    if (Buffer.byteLength(wrapped, "utf8") <= OBSERVABILITY_PAYLOAD_MAX_BYTES) return wrapped;
    head = head.slice(0, Math.floor(head.length * 0.9));
  }
}

/**
 * `ledgerBytes` is the size of the ledger's `payload_json`; `payload` the text read with
 * `PAYLOAD_SQL`, so a screenshot arrives already without its image bytes.
 */
export function shapePayload(
  policy: ObservabilityPayloadPolicy,
  payload: string,
  ledgerBytes: number,
  privateChat: boolean,
): ShapedPayload {
  if (policy === "derived" || privateChat) return { json: null, bytes: ledgerBytes, truncated: 0 };
  if (Buffer.byteLength(payload, "utf8") <= OBSERVABILITY_PAYLOAD_MAX_BYTES)
    return { json: payload, bytes: ledgerBytes, truncated: 0 };
  return { json: truncated(payload, ledgerBytes), bytes: ledgerBytes, truncated: 1 };
}

/** Free text a dashboard can show (summary text): withheld under `derived` and in private chats. */
export function shapeText(
  policy: ObservabilityPayloadPolicy,
  text: string | null,
  privateChat: boolean,
): string | null {
  return policy === "derived" || privateChat ? null : text;
}
