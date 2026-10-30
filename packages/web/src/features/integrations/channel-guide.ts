// A channel method's setup guide as the Web shows it (ADR-0047 amendment 2): manifest English
// with optional catalog translations (G4), the verified account's open link (G3) and the copy
// values with their one placeholder filled (G1). Nothing here names a provider.

import {
  CHANNEL_WEBHOOK_PATH_PLACEHOLDER,
  type ChannelConnection,
  type ChannelConnectionMethod,
  channelOpenUrl,
} from "@deskmates/contracts";
import { ENGLISH, type MessageKey } from "../../i18n/catalogs.js";
import { useLocale, useT } from "../../i18n/i18n-provider.js";

/** A key segment: the catalog's keys hold letters and digits only between dots. */
const segment = (value: string) => value.replace(/[^A-Za-z0-9]/g, "_");

/** The catalog key of a piece of a plugin's or method's English text (G4). */
export function channelGuideKey(pluginId: string, ...path: string[]): string {
  return ["channelGuide", segment(pluginId), ...path.map(segment)].join(".");
}

/**
 * The text to show: a translation in any language but English when the catalog has the key, the
 * manifest's English otherwise. English always comes from the manifest, so a release that changes
 * a step can never be shown an older English copy.
 */
export function guideText(
  translate: (key: MessageKey) => string,
  has: (key: string) => boolean,
  locale: string,
  key: string,
  english: string,
): string {
  return locale !== "en" && has(key) ? translate(key as MessageKey) : english;
}

/** The path a provider posts webhooks to for a single-connection plugin (ADR-0017 amendment 1). */
export function channelWebhookPath(workspaceId: string, pluginId: string): string {
  return `/api/channel-webhooks/${encodeURIComponent(workspaceId)}/${encodeURIComponent(pluginId)}`;
}

/** A copy value with `{webhookPath}` filled; nothing else is a placeholder there (G1). */
export function fillCopyValue(value: string, workspaceId: string, pluginId: string): string {
  return value
    .split(CHANNEL_WEBHOOK_PATH_PLACEHOLDER)
    .join(channelWebhookPath(workspaceId, pluginId));
}

/** The verified account's link (G3), or undefined while it is pending or has no usable handle. */
export function connectionOpenUrl(
  method: Pick<ChannelConnectionMethod, "open"> | undefined,
  connection: Pick<ChannelConnection, "identityKey" | "identityLabel">,
): string | undefined {
  if (!method?.open) return undefined;
  return channelOpenUrl(method.open.url, {
    identityKey: connection.identityKey,
    label: connection.identityLabel,
  });
}

/** `guideText` for the current language: `(key, english) => text`. */
export function useGuideText(): (key: string, english: string) => string {
  const t = useT();
  const locale = useLocale();
  return (key, english) => guideText(t, (candidate) => candidate in ENGLISH, locale, key, english);
}
