import type { ChannelMenuRequest } from "@deskmates/contracts";
import { FakeChannelProvider } from "@deskmates/testkit";
import { expect, it } from "vitest";
import { startChannelFixture } from "../test-support/channel-connections.js";

it("manages the guarded connection and audits sync without changing its transport state", async () => {
  const fake = new FakeChannelProvider();
  fake.addAccount("tok-a", { accountId: "1", label: "test" });
  fake.plugin.manifest.commandMenu = [{ command: "help", description: "Help" }];
  const create = fake.plugin.create;
  const calls: ChannelMenuRequest[] = [];
  fake.plugin.create = async (context) => ({
    ...(await create(context)),
    commandMenu: async (_id, input) => {
      calls.push(input);
      return { commands: [{ command: "help", description: "Help" }], menuButton: "web_app" };
    },
  });
  const fx = await startChannelFixture([fake]);
  try {
    const {
      json: { connection },
    } = await fx.connect({ pluginId: "fakechat", token: "tok-a", botId: fx.alice.id });
    const path = `/api/workspaces/${fx.workspace.id}/channel-connections/${connection.id}/command-menu`;
    expect(
      (await fx.harness.api("POST", path, { operation: "inspect", scope: "default" })).status,
    ).toBe(200);
    expect(
      (
        await fx.harness.api("POST", path, {
          operation: "sync",
          scope: "chat",
          chatId: "42",
          languageCode: "zh",
        })
      ).status,
    ).toBe(200);
    expect(
      fx.ctx.audit
        .list({ workspaceId: fx.workspace.id })
        .filter((entry) => entry.action === "channel.menu_sync"),
    ).toHaveLength(1);
    expect(
      (
        await fx.harness.api("POST", path.replace(fx.workspace.id, fx.other.workspace.id), {
          operation: "sync",
          scope: "default",
        })
      ).status,
    ).toBe(404);
    expect((await fx.harness.api("POST", path, { operation: "sync", scope: "chat" })).status).toBe(
      400,
    );
    expect(calls).toHaveLength(2);
    expect(
      (await fx.harness.api("GET", `/api/workspaces/${fx.workspace.id}/channels`)).status,
    ).toBe(200);
  } finally {
    await fx.close();
  }
});
