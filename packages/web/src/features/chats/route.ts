// Chats: the landing screen and `#/threads[/<id>[?message=<id>]]`.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    /** The landing screen, and where every address no module parses lands. */
    home: { name: "home" };
    threads: { name: "threads"; id?: string; messageId?: string };
  }
}

/** The chat list. */
export function threadsHref(): string {
  return "#/threads";
}

export function threadHref(id: string, messageId?: string): string {
  return `#/threads/${encodeURIComponent(id)}${messageId ? `?message=${encodeURIComponent(messageId)}` : ""}`;
}

export const routes = defineRoutes({
  screens: { home: "getting-started", threads: "chats-and-groups" },
  segments: {
    threads: (rest) => {
      if (!rest) return { name: "threads" };
      const [id, query] = rest.split("?", 2);
      const messageId = new URLSearchParams(query).get("message");
      return {
        name: "threads",
        id: decodeURIComponent(id ?? ""),
        ...(messageId ? { messageId } : {}),
      };
    },
  },
});
