// The Cloud API webhook body, reduced to what the adapter acts on (ADR-0017 decision 5). Only
// text messages carry content into a thread; everything else is named so it can be counted and
// acknowledged. Nothing but the message text, the sender's wa_id and ids is kept: the profile
// name and any other field never leave this function.

export interface InboundText {
  kind: "text";
  /** Meta's message id (`wamid.…`), the thread message's `externalId`. */
  id: string;
  /** Sender `wa_id`: E.164 digits without `+`. */
  from: string;
  /** The business number the message was sent to. */
  phoneNumberId: string;
  text: string;
  /** Unix seconds as Meta sends them. */
  timestamp: string;
}

export interface InboundUnsupported {
  kind: "unsupported";
  id: string;
  from: string;
  phoneNumberId: string;
  /** Meta's `type`: image, audio, document, sticker, location, reaction, contacts, … */
  type: string;
}

export interface InboundStatus {
  kind: "status";
  phoneNumberId: string;
  /** How many status entries the change carried. */
  count: number;
}

export interface InboundMalformed {
  kind: "malformed";
  detail: string;
}

export type InboundEvent = InboundText | InboundUnsupported | InboundStatus | InboundMalformed;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Walk `entry[].changes[].value` and emit one event per message or status block. A body that is
 * not a WhatsApp Business Account notification yields a single `malformed` event; the caller
 * still acknowledges it so Meta does not retry something that will never parse.
 */
export function parseWebhookPayload(body: unknown): InboundEvent[] {
  const root = record(body);
  if (!root) return [{ kind: "malformed", detail: "body is not an object" }];
  if (root.object !== "whatsapp_business_account") {
    return [{ kind: "malformed", detail: `object is ${String(root.object)}` }];
  }
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const out: InboundEvent[] = [];
  for (const entry of entries) {
    const changes = Array.isArray(record(entry)?.changes)
      ? (record(entry)?.changes as unknown[])
      : [];
    for (const change of changes) {
      const value = record(record(change)?.value);
      if (!value) continue;
      const phoneNumberId = str(record(value.metadata)?.phone_number_id) ?? "";
      if (Array.isArray(value.statuses) && value.statuses.length > 0) {
        out.push({ kind: "status", phoneNumberId, count: value.statuses.length });
      }
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const raw of messages) {
        const message = record(raw);
        const id = str(message?.id);
        const from = str(message?.from);
        const type = str(message?.type);
        if (!message || !id || !from || !type) {
          out.push({ kind: "malformed", detail: "message without id, from or type" });
          continue;
        }
        if (type === "text") {
          const text = str(record(message.text)?.body);
          if (text === undefined) {
            out.push({ kind: "malformed", detail: `text message ${id} without a body` });
            continue;
          }
          out.push({
            kind: "text",
            id,
            from,
            phoneNumberId,
            text,
            timestamp: str(message.timestamp) ?? "",
          });
        } else {
          out.push({ kind: "unsupported", id, from, phoneNumberId, type });
        }
      }
    }
  }
  return out;
}
