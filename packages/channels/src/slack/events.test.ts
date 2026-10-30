// T0: reducing Socket Mode frames (ADR-0047: 1:1 only, own messages ignored).

import { describe, expect, it } from "vitest";
import { parseSlackFrame } from "./events.js";
import { type FakeSlackInstall, messageEnvelope } from "./testing/fake-slack.js";

const INSTALL: FakeSlackInstall = {
  teamId: "T1",
  teamName: "Team",
  appId: "A1",
  botId: "B1",
  botUserId: "UBOT",
  botName: "bot",
};

const parse = (frame: unknown) => parseSlackFrame(JSON.stringify(frame), "UBOT");

describe("parseSlackFrame", () => {
  it("reads hello and disconnect frames", () => {
    expect(parse({ type: "hello", connection_info: { app_id: "A1" } })).toEqual({
      kind: "hello",
      appId: "A1",
    });
    expect(parse({ type: "disconnect", reason: "refresh_requested" })).toEqual({
      kind: "disconnect",
      reason: "refresh_requested",
    });
    expect(parseSlackFrame("not json", "UBOT")).toEqual({ kind: "unknown" });
  });

  it("reduces a DM to its message and origin", () => {
    const frame = parse(
      messageEnvelope({
        envelopeId: "e1",
        eventId: "Ev1",
        install: INSTALL,
        user: "U9",
        text: "hi",
      }),
    );
    expect(frame).toEqual({
      kind: "envelope",
      envelopeId: "e1",
      payload: {
        kind: "message",
        origin: { teamId: "T1", enterpriseId: "", appId: "A1" },
        message: {
          eventId: "Ev1",
          channel: "D0PERSON1",
          user: "U9",
          text: "hi",
          ts: "1700000000.000100",
          files: [],
          threadReply: false,
        },
      },
    });
  });

  it("ignores everything that is not a person's direct message", () => {
    const reason = (extra: Partial<Parameters<typeof messageEnvelope>[0]>) => {
      const frame = parse(
        messageEnvelope({ envelopeId: "e", eventId: "Ev", install: INSTALL, user: "U9", ...extra }),
      );
      return frame.kind === "envelope" && frame.payload.kind === "ignored"
        ? frame.payload.reason
        : frame.kind === "envelope"
          ? frame.payload.kind
          : frame.kind;
    };
    expect(reason({ channelType: "channel", channel: "C1" })).toBe("not_a_direct_message");
    expect(reason({ channelType: "mpim", channel: "G1" })).toBe("not_a_direct_message");
    expect(reason({ channelType: "group", channel: "G2" })).toBe("not_a_direct_message");
    expect(reason({ subtype: "message_deleted" })).toBe("subtype");
    expect(reason({ botId: "B1" })).toBe("bot_message");
    expect(reason({ user: "UBOT" })).toBe("bot_message");
    expect(reason({ subtype: "file_share" })).toBe("message");
    expect(parse({ type: "slash_commands", envelope_id: "e2", payload: {} })).toMatchObject({
      kind: "envelope",
      payload: { kind: "ignored", reason: "not_an_event" },
    });
  });

  it("marks a DM thread reply and withholds unusable files", () => {
    const frame = parse(
      messageEnvelope({
        envelopeId: "e",
        eventId: "Ev",
        install: INSTALL,
        user: "U9",
        threadTs: "1.0",
        files: [
          {
            id: "F1",
            name: "a.png",
            mimetype: "IMAGE/PNG",
            size: 3,
            url_private_download: "https://files.slack.com/a",
          },
          { id: "F2", name: "b.png", mimetype: "image/png", mode: "tombstone" },
        ],
      }),
    );
    expect(
      frame.kind === "envelope" && frame.payload.kind === "message" && frame.payload.message,
    ).toMatchObject({
      threadReply: true,
      files: [
        { id: "F1", mimeType: "image/png", size: 3, url: "https://files.slack.com/a" },
        { id: "F2", url: undefined },
      ],
    });
  });
});
