// ADR-0047 decision 10: a run woken in an ABI-2 channel thread records the connection, plugin and
// binding generation in `runs.config_json`, so its usage and cost attribute to the connection
// without reading the mutable connection row later. Every other thread adds nothing.

import type { Thread } from "@deskmates/contracts";

export interface ChannelRunConfig {
  channelConnection: { id: string; pluginId: string; bindingGeneration: number };
}

export function channelRunStamp(
  thread: Pick<Thread, "channel" | "channelConnectionId" | "bindingGeneration">,
): ChannelRunConfig | Record<string, never> {
  if (thread.channelConnectionId === undefined || thread.bindingGeneration === undefined) return {};
  return {
    channelConnection: {
      id: thread.channelConnectionId,
      pluginId: thread.channel,
      bindingGeneration: thread.bindingGeneration,
    },
  };
}
