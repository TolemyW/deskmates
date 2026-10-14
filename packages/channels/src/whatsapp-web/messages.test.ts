import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it, vi } from "vitest";
import { phoneFromJid, reduceWebMessage } from "./messages.js";

const ACCOUNT = "15550001111";
const message = (
  key: WAMessage["key"] = {},
  content: WAMessage["message"] = { conversation: "hello" },
): WAMessage => ({
  key: { id: "m1", remoteJid: "15550002222@s.whatsapp.net", ...key },
  message: content,
});
const resolve = vi.fn(async () => null);
const reduce = (m: WAMessage, own = false) => reduceWebMessage(m, ACCOUNT, () => own, resolve);

describe("linked-device input reduction", () => {
  it("namespaces one direct message by account and strips device suffix", async () => {
    expect(phoneFromJid("15550002222:9@s.whatsapp.net")).toBe("15550002222");
    expect(await reduce(message())).toMatchObject({
      kind: "text",
      from: "15550002222",
      id: `web:${ACCOUNT}:m1`,
      phoneNumberId: `web:${ACCOUNT}`,
      text: "hello",
    });
  });
  it("admits self-chat but ignores sent messages to other people and persisted echoes", async () => {
    expect(
      await reduce(message({ fromMe: true, remoteJid: `${ACCOUNT}@s.whatsapp.net` })),
    ).toMatchObject({ kind: "text", from: ACCOUNT });
    expect(await reduce(message({ fromMe: true }))).toBeUndefined();
    expect(
      await reduce(message({ fromMe: true, remoteJid: `${ACCOUNT}@s.whatsapp.net` }), true),
    ).toBeUndefined();
  });
  it("never treats a LID as a phone number; accepts only a client mapping or phone alternative", async () => {
    expect(phoneFromJid("123456789@lid")).toBeUndefined();
    expect(await reduce(message({ remoteJid: "123456789@lid" }))).toBeUndefined();
    expect(
      await reduce(
        message({ remoteJid: "123456789@lid", remoteJidAlt: "15550002222@s.whatsapp.net" }),
      ),
    ).toMatchObject({ from: "15550002222" });
    expect(
      await reduceWebMessage(
        message({ remoteJid: "123456789@lid" }),
        ACCOUNT,
        () => false,
        async () => "15550003333@s.whatsapp.net",
      ),
    ).toMatchObject({ from: "15550003333" });
  });
  it.each(["1@g.us", "status@broadcast", "1@newsletter"])("drops %s", async (jid) => {
    expect(
      await reduce(message({ remoteJid: jid, remoteJidAlt: `${ACCOUNT}@s.whatsapp.net` })),
    ).toBeUndefined();
  });
  it("does not turn protocol, reactions or edits into a bot wake", async () => {
    for (const content of [
      { protocolMessage: {} },
      { reactionMessage: { text: "👍" } },
      { editedMessage: { message: { conversation: "edit" } } },
    ]) {
      expect(await reduce(message({}, content))).toBeUndefined();
    }
  });
  it("unwraps ephemeral text but treats a captioned image as unsupported", async () => {
    expect(
      await reduce(
        message(
          {},
          { ephemeralMessage: { message: { extendedTextMessage: { text: "wrapped" } } } },
        ),
      ),
    ).toMatchObject({ kind: "text", text: "wrapped" });
    expect(
      await reduce(message({}, { imageMessage: { caption: "do not run this" } })),
    ).toMatchObject({ kind: "unsupported" });
  });
});
