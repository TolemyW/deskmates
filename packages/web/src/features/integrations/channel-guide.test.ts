// @vitest-environment node
// T0, ADR-0047 amendment 2 G3 and G4: the open link of a verified account, the webhook path in a
// copy value, and translations that fall back to the manifest's English.

import { describe, expect, it } from "vitest";
import { channelGuideKey, connectionOpenUrl, fillCopyValue, guideText } from "./channel-guide.js";

describe("open link (G3)", () => {
  const telegram = { open: { label: "Open in Telegram", url: "https://t.me/{handle}" } };
  const slack = {
    open: {
      label: "Open in Slack",
      url: "https://slack.com/app_redirect?app={id}&team={namespace}",
    },
  };

  it("fills a verified Telegram identity into its t.me link", () => {
    expect(
      connectionOpenUrl(telegram, { identityKey: "telegram:bot:42", identityLabel: "@ops_bot" }),
    ).toBe("https://t.me/ops_bot");
  });

  it("encodes the identity's parts", () => {
    expect(
      connectionOpenUrl(slack, { identityKey: "slack:T 1:A&2", identityLabel: "ops in Team" }),
    ).toBe("https://slack.com/app_redirect?app=A%262&team=T%201");
  });

  it("shows no link for a pending identity, a label that is not a handle, or no template", () => {
    expect(
      connectionOpenUrl(telegram, { identityKey: "telegram:pending:c1", identityLabel: "@x" }),
    ).toBeUndefined();
    expect(
      connectionOpenUrl(telegram, { identityKey: "telegram:bot:42", identityLabel: "Ops Bot" }),
    ).toBeUndefined();
    expect(connectionOpenUrl(telegram, { identityLabel: "@ops_bot" })).toBeUndefined();
    expect(
      connectionOpenUrl({}, { identityKey: "telegram:bot:42", identityLabel: "@ops_bot" }),
    ).toBeUndefined();
  });
});

describe("copy values (G1)", () => {
  it("replaces the webhook placeholder with the plugin's path and nothing else", () => {
    expect(fillCopyValue("{webhookPath}", "ws 1", "whatsapp")).toBe(
      "/api/channel-webhooks/ws%201/whatsapp",
    );
    expect(fillCopyValue('{ "a": 1 }', "ws_1", "slack")).toBe('{ "a": 1 }');
  });
});

describe("translations (G4)", () => {
  const catalog: Record<string, string> = { "channelGuide.telegram.token.step.paste": "粘贴" };
  const translate = (key: string) => catalog[key] ?? key;
  const has = (key: string) => key in catalog;

  it("keys letters and digits only between dots", () => {
    expect(channelGuideKey("slack", "socket-mode", "field", "botToken")).toBe(
      "channelGuide.slack.socket_mode.field.botToken",
    );
  });

  it("uses a translation in another language and the manifest's English otherwise", () => {
    const key = "channelGuide.telegram.token.step.paste";
    expect(guideText(translate as never, has, "zh-CN", key, "Paste it")).toBe("粘贴");
    expect(guideText(translate as never, has, "en", key, "Paste it")).toBe("Paste it");
    expect(
      guideText(translate as never, has, "zh-CN", "channelGuide.telegram.token.step.new", "New"),
    ).toBe("New");
  });
});
