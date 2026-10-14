// Operator route policies for threads; aggregated in `../route-policy.ts` (ADR-0022 P2).

import { type PolicyTable, admin, guest, member } from "./policy.js";

export const threadsRoutePolicies: PolicyTable = {
  // ADR-0022 amendment 6: Guests read the shared chats (never a bus thread) and open private
  // inquiries; the guard makes another person's private chat the uniform 404 on every route.
  "GET /api/threads": guest({
    query: { workspaceId: "workspace" },
    scopedList: true,
    handlerCheck: "listed only from the caller's workspaces, without other people's private chats",
  }),
  "POST /api/threads": guest({
    body: { workspaceId: "workspace", botIds: "bot[]" },
    handlerCheck:
      "below Admin in the workspace (Member, Guest, member principal) opens only a private chat: one bot, the web channel, no external binding",
  }),
  "GET /api/threads/:id": guest({ params: { id: "thread" } }),
  "PATCH /api/threads/:id": admin({ params: { id: "thread" } }),
  "GET /api/threads/:id/activity": guest({ params: { id: "thread" } }),
  "POST /api/threads/:id/activity/read": guest({ params: { id: "thread" } }),
  "POST /api/threads/:id/pin": member({ params: { id: "thread" } }),
  "DELETE /api/threads/:id/pin": member({ params: { id: "thread" } }),
  "POST /api/threads/:id/members": admin({
    params: { id: "thread" },
    body: { botIds: "bot[]" },
  }),
  "DELETE /api/threads/:id/members/:botId": admin({
    params: { id: "thread", botId: "bot" },
  }),
  "GET /api/threads/:id/messages": guest({ params: { id: "thread" } }),
  // Request rounds (ADR-0005 amendment 4): the round is looked up inside the guarded thread.
  // A Guest reads them like the messages they summarise.
  "GET /api/threads/:id/rounds": guest({ params: { id: "thread" } }),
  "POST /api/threads/:id/rounds/:messageId/cancel": member({
    params: { id: "thread" },
    handlerCheck:
      "a Member (person or member principal) cancels a round only in a side chat it opened",
  }),
  "POST /api/threads/:id/rounds/:messageId/members/:botId/retry": member({
    params: { id: "thread", botId: "bot" },
    handlerCheck:
      "a Member (person or member principal) retries a round member only in a side chat it opened",
  }),
  "POST /api/threads/:id/messages": guest({
    params: { id: "thread" },
    handlerCheck:
      "a Guest posts only in their own private inquiry, answered by a status job (guest_read_only elsewhere; status_inquiry_busy while one is open); a Member (person or member principal) posts in chat threads only, never a bus thread, and a mention that would add a bot is refused; no person or service principal posts to a thread owned by an external chat channel (a read-only Web mirror, ADR-0017 amendment 2)",
  }),
  // Closing a thread's task notes writes learned memory (an episode and distilled facts).
  "POST /api/threads/:id/close-task": admin({ params: { id: "thread" } }),
};
