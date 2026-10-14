import { describe, expect, it } from "vitest";
import { parseWebhookPayload } from "./webhook-payload.js";

function notification(value: Record<string, unknown>): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value }] }],
  };
}

const metadata = { display_phone_number: "15550001111", phone_number_id: "100200" };

describe("parseWebhookPayload", () => {
  it("reduces a text message to id, sender, number and text, dropping the profile", () => {
    const events = parseWebhookPayload(
      notification({
        messaging_product: "whatsapp",
        metadata,
        contacts: [{ profile: { name: "Ignored Name" }, wa_id: "8613800000000" }],
        messages: [
          {
            from: "8613800000000",
            id: "wamid.A",
            timestamp: "1759400000",
            type: "text",
            text: { body: "@nova what is the backlog?" },
          },
        ],
      }),
    );
    expect(events).toEqual([
      {
        kind: "text",
        id: "wamid.A",
        from: "8613800000000",
        phoneNumberId: "100200",
        text: "@nova what is the backlog?",
        timestamp: "1759400000",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("Ignored Name");
  });

  it("names non-text messages and status blocks without content", () => {
    const events = parseWebhookPayload(
      notification({
        metadata,
        statuses: [
          { id: "wamid.X", status: "delivered" },
          { id: "wamid.Y", status: "read" },
        ],
        messages: [
          {
            from: "8613800000000",
            id: "wamid.B",
            timestamp: "1",
            type: "image",
            image: { id: "m" },
          },
          { from: "8613800000000", id: "wamid.C", timestamp: "2", type: "reaction" },
        ],
      }),
    );
    expect(events).toEqual([
      { kind: "status", phoneNumberId: "100200", count: 2 },
      {
        kind: "unsupported",
        id: "wamid.B",
        from: "8613800000000",
        phoneNumberId: "100200",
        type: "image",
      },
      {
        kind: "unsupported",
        id: "wamid.C",
        from: "8613800000000",
        phoneNumberId: "100200",
        type: "reaction",
      },
    ]);
  });

  it("reports malformed bodies instead of throwing", () => {
    expect(parseWebhookPayload(null)).toEqual([
      { kind: "malformed", detail: "body is not an object" },
    ]);
    expect(parseWebhookPayload({ object: "page" })).toEqual([
      { kind: "malformed", detail: "object is page" },
    ]);
    expect(parseWebhookPayload({ object: "whatsapp_business_account" })).toEqual([]);
    const events = parseWebhookPayload(
      notification({
        metadata,
        messages: [{ from: "861", id: "wamid.D", type: "text", text: {} }, { type: "text" }],
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["malformed", "malformed"]);
  });
});
