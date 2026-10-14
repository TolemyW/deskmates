// @vitest-environment jsdom
// An avatar draws the operator's emoji and colour when the bot has one, by name through the
// registry or straight from the row, and initials on a name-derived hue otherwise.

import type { BotDefinition, BotId, WorkspaceId } from "@deskmates/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BotAvatarsProvider, useRememberBots } from "../../state/bot-avatars.js";
import { Avatar, avatarHue, initials } from "./avatar.js";

afterEach(cleanup);

const bot: BotDefinition = {
  id: "bot_chief" as BotId,
  name: "chief",
  role: "lead",
  workspaceId: "ws_1" as WorkspaceId,
  avatar: { emoji: "🧭", color: "indigo" },
  soulVersion: 0,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: "2026-10-01T00:00:00.000Z",
};

function Remember({ bots }: { bots: readonly BotDefinition[] }) {
  useRememberBots()(bots);
  return null;
}

describe("Avatar", () => {
  it("falls back to initials on a stable hue", () => {
    const { container } = render(<Avatar name="chief" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe("ch");
    expect(el.dataset.hue).toBe(String(avatarHue("chief")));
    expect(el.dataset.color).toBeUndefined();
    expect(initials("web research")).toBe("wr");
  });

  it("draws the chosen emoji and colour from the row or the registry", () => {
    const direct = render(<Avatar name="chief" avatar={bot.avatar} />);
    const el = direct.container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe("🧭");
    expect(el.dataset.color).toBe("indigo");
    expect(el.dataset.hue).toBeUndefined();
    expect(el.className).toContain("emoji");
    direct.unmount();

    const viaRegistry = render(
      <BotAvatarsProvider>
        <Remember bots={[bot]} />
        <Avatar name="chief" />
        <Avatar name="qa" />
      </BotAvatarsProvider>,
    );
    const [chief, qa] = Array.from(viaRegistry.container.querySelectorAll(".avatar"));
    expect(chief?.textContent).toBe("🧭");
    expect(qa?.textContent).toBe("qa");
  });
});
