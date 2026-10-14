// The thread domain's stores, built together for `buildContext` (issue #53). The router is not
// here: it joins threads to runs, events and the bus, so `buildContext` wires it explicitly.

import type { BotStore } from "../bots/bots.js";
import type { GatewayDb } from "../db/open.js";
import type { EventBus } from "../events/bus.js";
import { MessageStore } from "./messages.js";
import { PrivateChatStore } from "./private-chats.js";
import { RoundStore } from "./rounds.js";
import { RoutingWalkStore } from "./routing-walks.js";
import { SessionStore } from "./sessions.js";
import { ThreadPinStore } from "./thread-pins.js";
import { ThreadStore } from "./threads.js";

export interface ThreadModule {
  threads: ThreadStore;
  messages: MessageStore;
  walks: RoutingWalkStore;
  /** Durable request rounds (ADR-0005 amendment 4); routing writes them and never reads them. */
  rounds: RoundStore;
  privateChats: PrivateChatStore;
  /** Workspace-shared rail presentation; routing and scheduling never read it. */
  threadPins: ThreadPinStore;
  sessions: SessionStore;
}

export function createThreadModule(db: GatewayDb, bus: EventBus, bots: BotStore): ThreadModule {
  const threads = new ThreadStore(db);
  const privateChats = new PrivateChatStore(db, threads, bots);
  // A run's status change is activity in every private chat it reports to (ADR-0024).
  bus.subscribe((event) => {
    if (event.type === "run_status") {
      for (const threadId of privateChats.forRun(event.run.id))
        bus.publish({ type: "thread_activity", threadId });
    }
  });
  return {
    threads,
    messages: new MessageStore(db),
    walks: new RoutingWalkStore(db),
    rounds: new RoundStore(db),
    privateChats,
    threadPins: new ThreadPinStore(db, threads),
    sessions: new SessionStore(db),
  };
}
