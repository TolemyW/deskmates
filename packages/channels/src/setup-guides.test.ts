// T1: every release channel plugin ships a setup guide that ADR-0047 amendment 2 accepts, for
// every method, with help on every field a person types, and no secret field offered for copying.

import { channelManifestV2Problems } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { channelPlugin as discord } from "./discord/plugin.js";
import { channelPlugin as slack } from "./slack/plugin.js";
import { channelPlugin as telegram } from "./telegram/plugin.js";
import { channelPlugin as whatsapp } from "./whatsapp/plugin.js";

const plugins = [discord, slack, telegram, whatsapp];

describe("release channel setup guides", () => {
  for (const { manifest } of plugins)
    it(`${manifest.id}: guides every method and passes the manifest check`, () => {
      expect(channelManifestV2Problems(manifest)).toEqual([]);
      for (const method of manifest.methods) {
        expect(method.setup?.steps.length, `${method.id} steps`).toBeGreaterThan(1);
        for (const field of method.fields)
          expect(field.help, `${method.id}.${field.key}`).toBeTruthy();
        for (const step of method.setup?.steps ?? []) {
          if (step.link) expect(new URL(step.link.url).protocol).toBe("https:");
          for (const field of method.fields.filter((item) => item.secret))
            expect(step.copy?.value ?? "").not.toContain(`{${field.key}}`);
        }
      }
    });

  it("offers a valid Slack app manifest with the scopes and event the plugin needs", () => {
    const step = slack.manifest.methods[0]?.setup?.steps.find((item) => item.copy);
    const app = JSON.parse(step?.copy?.value ?? "{}");
    expect(app.settings.socket_mode_enabled).toBe(true);
    expect(app.settings.event_subscriptions.bot_events).toEqual(["message.im"]);
    expect(app.oauth_config.scopes.bot.sort()).toEqual(
      ["chat:write", "files:read", "im:history", "users:read"].sort(),
    );
    expect(app.features.app_home.messages_tab_enabled).toBe(true);
  });
});
