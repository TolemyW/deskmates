// A WhatsApp connection's identity (ADR-0047 decision 6, amendment 1). The Cloud API number is
// verified with the operator's access token against the Graph API's own phone-number node before
// anything is stored; a linked device's number is known only after the QR scan and is claimed
// through the host then. Neither key holds credential material.

import type { ChannelIdentity } from "@deskmates/contracts";

/** `whatsapp:cloud:<phone number id>`, the Business Platform's id for the number. */
export function cloudIdentityKey(phoneNumberId: string): string {
  return `whatsapp:cloud:${phoneNumberId}`;
}

/** `whatsapp:linked:<E.164 digits>`, the number a linked device belongs to. */
export function linkedIdentityKey(account: string): string {
  return `whatsapp:linked:${account}`;
}

/** The identity of a linked device, as `claimIdentity` takes it. */
export function linkedIdentity(account: string): ChannelIdentity {
  return { identityKey: linkedIdentityKey(account), label: `+${account}` };
}

/**
 * Ask the Graph API which number the access token reaches. The answer must name the configured
 * phone number id; the label is the business name and display number Meta returns.
 */
export async function verifyCloudNumber(input: {
  fetch: typeof fetch;
  graphBaseUrl: string;
  graphApiVersion: string;
  phoneNumberId: string;
  accessToken: string;
}): Promise<ChannelIdentity> {
  const url = `${input.graphBaseUrl}/${input.graphApiVersion}/${encodeURIComponent(input.phoneNumberId)}?fields=id,display_phone_number,verified_name`;
  const response = await input.fetch(url, {
    headers: { accept: "application/json", authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) throw new Error(`the Graph API refused the number (${response.status})`);
  const body = (await response.json().catch(() => ({}))) as {
    id?: unknown;
    display_phone_number?: unknown;
    verified_name?: unknown;
  };
  if (body.id !== input.phoneNumberId)
    throw new Error("the Graph API answered for another phone number id");
  const display = typeof body.display_phone_number === "string" ? body.display_phone_number : "";
  const name = typeof body.verified_name === "string" ? body.verified_name : "";
  return {
    identityKey: cloudIdentityKey(input.phoneNumberId),
    label: name && display ? `${name} (${display})` : display || name || input.phoneNumberId,
  };
}
