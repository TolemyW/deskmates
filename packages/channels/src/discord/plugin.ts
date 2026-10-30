// Release entry point of the Discord channel plugin (ChannelPlugin ABI 2, ADR-0047). The Gateway
// imports this module at startup to read the manifest; the runtime module is imported only when
// the Gateway first verifies, opens or restores a Discord connection (decision 15).

import type { ChannelPluginV2 } from "@deskmates/contracts";
import { discordManifest } from "./manifest.js";

export const channelPlugin: ChannelPluginV2 = {
  manifest: discordManifest,
  create: async (context) => {
    const { DiscordRuntime } = await import("./runtime.js");
    return new DiscordRuntime(context);
  },
};
