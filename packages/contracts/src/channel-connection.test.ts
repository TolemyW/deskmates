// T0: the ChannelPlugin ABI 2 shapes (ADR-0047): the manifest check the loader applies, the
// identity key form, and the fixed rebind notice.

import { describe, expect, it } from "vitest";
import {
  CHANNEL_CAPABILITY_ROWS,
  type ChannelCapabilityMatrix,
  type ChannelPluginManifestV2,
  SUPPORTED_CHANNEL_PLUGIN_API_VERSIONS,
  channelManifestV2Problems,
  channelPendingIdentityKey,
  channelRebindNotice,
  channelSenderAdmission,
  isChannelIdentityKey,
  isPendingChannelIdentityKey,
  parseChannelSenderList,
} from "./channel-connection.js";

const capabilities: ChannelCapabilityMatrix = {
  directMessages: "available",
  groups: "unavailable",
  inboundImages: "available",
  inboundOtherMedia: "disabled",
  outboundReply: "available",
  proactiveMessages: "unavailable",
  streaming: "disabled",
  approvals: "available",
  testMessage: "unavailable",
};

const manifest: ChannelPluginManifestV2 = {
  apiVersion: 2,
  id: "telegram",
  version: "1.0.0",
  displayName: "Telegram",
  description: "A Telegram bot per connection.",
  multipleConnections: true,
  capabilities,
  methods: [{ id: "token", label: "Bot token", description: "x", fields: [] }],
  statusVocabulary: ["connected"],
};

describe("ChannelPlugin ABI 2 (ADR-0047)", () => {
  it("loads ABI 1 and ABI 2 and nothing else", () => {
    expect(SUPPORTED_CHANNEL_PLUGIN_API_VERSIONS).toEqual([1, 2]);
  });

  it("accepts a manifest that declares every capability row", () => {
    expect(channelManifestV2Problems(manifest)).toEqual([]);
    expect(Object.keys(capabilities).sort()).toEqual([...CHANNEL_CAPABILITY_ROWS].sort());
  });

  it("refuses a missing row, an unknown state, an unknown row and any group support", () => {
    const { inboundImages: _dropped, ...missing } = capabilities;
    expect(channelManifestV2Problems({ ...manifest, capabilities: missing })).toContain(
      "capability inboundImages must be available, disabled or unavailable",
    );
    expect(
      channelManifestV2Problems({
        ...manifest,
        capabilities: { ...capabilities, streaming: "on" },
      }),
    ).toContain("capability streaming must be available, disabled or unavailable");
    expect(
      channelManifestV2Problems({
        ...manifest,
        capabilities: { ...capabilities, voice: "available" },
      }),
    ).toContain("unknown capability voice");
    expect(
      channelManifestV2Problems({
        ...manifest,
        capabilities: { ...capabilities, groups: "disabled" },
      }),
    ).toContain("capability groups must be unavailable in this version");
    expect(channelManifestV2Problems({ ...manifest, multipleConnections: "yes" })).toContain(
      "multipleConnections must be a boolean",
    );
    expect(channelManifestV2Problems({ ...manifest, apiVersion: 1 })).toContain(
      "apiVersion must be 2",
    );
  });

  it("checks the identity key form and its plugin prefix", () => {
    expect(isChannelIdentityKey("telegram:bot:123456", "telegram")).toBe(true);
    expect(isChannelIdentityKey("slack:T0123:A0456", "slack")).toBe(true);
    expect(isChannelIdentityKey("telegram:bot:123456", "discord")).toBe(false);
    for (const bad of [
      "",
      "telegram",
      "telegram:bot",
      "telegram:bot:has space",
      "Telegram:bot:1",
      7,
    ])
      expect(isChannelIdentityKey(bad), String(bad)).toBe(false);
  });

  it("names the new assistant in the rebind notice", () => {
    expect(channelRebindNotice("Ada")).toBe(
      "This conversation is now handled by Ada. Earlier messages stay with the previous assistant and are not carried over.",
    );
  });

  it("defaults admission to the blocklist and checks a declared allowlist field (amendment 1)", () => {
    expect(channelSenderAdmission(manifest)).toEqual({ mode: "blocklist" });
    const listed = {
      ...manifest,
      senderAdmission: { mode: "allowlist" as const, field: "allowedSenders" },
      methods: [
        {
          id: "qr",
          label: "QR",
          description: "x",
          identity: "link" as const,
          fields: [{ key: "allowedSenders", label: "Allowed", kind: "phone-list" as const }],
        },
      ],
    };
    expect(channelManifestV2Problems(listed)).toEqual([]);
    expect(channelSenderAdmission(listed)).toEqual({ mode: "allowlist", field: "allowedSenders" });
    expect(
      channelManifestV2Problems({ ...listed, senderAdmission: { mode: "allowlist", field: "x" } }),
    ).toContain("senderAdmission allowlist must name a plain config field of every method");
    expect(channelManifestV2Problems({ ...listed, senderAdmission: { mode: "open" } })).toContain(
      "senderAdmission mode must be blocklist or allowlist",
    );
    expect(
      channelManifestV2Problems({
        ...listed,
        methods: [{ ...listed.methods[0], identity: "later" }],
      }),
    ).toContain("method qr identity must be verify or link");
    expect([...parseChannelSenderList(" +15550001111, ,15550002222 ")]).toEqual([
      "15550001111",
      "15550002222",
    ]);
    expect(parseChannelSenderList(undefined).size).toBe(0);
  });

  it("reserves the pending identity namespace for unclaimed link connections", () => {
    const pending = channelPendingIdentityKey("whatsapp", "chn_1");
    expect(pending).toBe("whatsapp:pending:chn_1");
    expect(isPendingChannelIdentityKey(pending)).toBe(true);
    expect(isPendingChannelIdentityKey("whatsapp:linked:15550001111")).toBe(false);
    expect(isChannelIdentityKey("whatsapp:pending:abc", "whatsapp")).toBe(false);
    expect(isChannelIdentityKey("whatsapp:linked:15550001111", "whatsapp")).toBe(true);
  });
});

describe("setup guides (ADR-0047 amendment 2)", () => {
  const step = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    text: "Do it.",
    ...extra,
  });
  const withMethod = (method: Record<string, unknown>) => ({
    ...manifest,
    methods: [{ id: "token", label: "Bot token", description: "x", fields: [], ...method }],
  });

  it("accepts steps with https links and copy values, field help and an open link", () => {
    expect(
      channelManifestV2Problems(
        withMethod({
          setup: {
            steps: [
              step("create", { link: { label: "Open BotFather", url: "https://t.me/BotFather" } }),
              step("webhook", {
                copy: { label: "Callback URL", value: "https://host{webhookPath}" },
              }),
            ],
          },
          open: { label: "Open in Telegram", url: "https://t.me/{handle}" },
          fields: [{ key: "token", label: "Bot token", kind: "password", help: "From BotFather." }],
        }),
      ),
    ).toEqual([]);
  });

  it("refuses too many or repeated steps, empty or overlong text and bad links (G1)", () => {
    const problems = (setup: unknown) => channelManifestV2Problems(withMethod({ setup }));
    expect(
      problems({ steps: Array.from({ length: 13 }, (_, i) => step(`s${i}`)) }).join(),
    ).toContain("more than 12 steps");
    expect(problems({ steps: [step("a"), step("a")] }).join()).toContain("repeated");
    expect(problems({ steps: [step("a", { text: " " })] }).join()).toContain("text must be");
    expect(problems({ steps: [step("a", { text: "x".repeat(401) })] }).join()).toContain(
      "text must be",
    );
    for (const url of ["http://t.me/BotFather", "/relative", "javascript:alert(1)"])
      expect(problems({ steps: [step("a", { link: { label: "L", url } })] }).join()).toContain(
        "https URL",
      );
    expect(
      problems({ steps: [step("a", { copy: { label: "Token", value: "{token}" } })] }).join(),
    ).toContain("without secrets");
    expect(problems({ steps: [] }).join()).toContain("must have steps");
  });

  it("refuses overlong field help (G2) and unknown open placeholders (G3)", () => {
    expect(
      channelManifestV2Problems(
        withMethod({ fields: [{ key: "token", label: "T", kind: "text", help: "x".repeat(301) }] }),
      ).join(),
    ).toContain("help must be");
    expect(
      channelManifestV2Problems(
        withMethod({ open: { label: "Open", url: "https://t.me/{token}" } }),
      ).join(),
    ).toContain("known placeholders");
    expect(
      channelManifestV2Problems(withMethod({ open: { label: "Open", url: "http://t.me/{id}" } }))
        .length,
    ).toBe(1);
  });
});
