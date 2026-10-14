import type { WAMessage } from "@whiskeysockets/baileys";
import type { InboundEvent } from "../whatsapp/webhook-payload.js";

/** Device suffixes are not phone digits; LIDs are never accepted as phone numbers. */
export function phoneFromJid(jid: string | null | undefined): string | undefined {
  return jid?.match(/^([0-9]{5,20})(?::[0-9]+)?@s\.whatsapp\.net$/)?.[1];
}

export async function reduceWebMessage(
  message: WAMessage,
  account: string,
  isOutbound: (id: string) => boolean,
  resolveLid: (jid: string) => Promise<string | null>,
): Promise<InboundEvent | undefined> {
  const key = message.key;
  if (!key.id || !key.remoteJid || isOutbound(key.id)) return;
  const remote = key.remoteJid;
  if (!remote.endsWith("@s.whatsapp.net") && !remote.endsWith("@lid")) return;
  const from =
    phoneFromJid(remote) ??
    phoneFromJid(key.remoteJidAlt) ??
    (remote.endsWith("@lid") ? phoneFromJid(await resolveLid(remote)) : undefined);
  if (!from || (key.fromMe && from !== account)) return;
  // Baileys' generic normalizer also unwraps edits and group-status content. Those
  // are not new human commands, so unwrap only text/media delivery envelopes here.
  let content = message.message;
  for (let i = 0; i < 5 && content; i++) {
    if (
      content.editedMessage ||
      content.groupStatusMessage ||
      content.groupStatusMessageV2 ||
      content.associatedChildMessage
    )
      return;
    const envelope =
      content.ephemeralMessage ??
      content.viewOnceMessage ??
      content.viewOnceMessageV2 ??
      content.viewOnceMessageV2Extension ??
      content.documentWithCaptionMessage;
    if (!envelope) break;
    content = envelope.message;
  }
  if (
    !content ||
    content.protocolMessage ||
    content.senderKeyDistributionMessage ||
    content.reactionMessage ||
    content.editedMessage
  )
    return;
  const text = content.conversation ?? content.extendedTextMessage?.text;
  const common = { id: `web:${account}:${key.id}`, from, phoneNumberId: `web:${account}` };
  if (typeof text === "string" && text.trim()) {
    return { kind: "text", ...common, text, timestamp: String(message.messageTimestamp ?? "") };
  }
  if (
    content.imageMessage ||
    content.audioMessage ||
    content.videoMessage ||
    content.documentMessage ||
    content.stickerMessage ||
    content.locationMessage
  ) {
    return { kind: "unsupported", ...common, type: "media" };
  }
  return undefined;
}
