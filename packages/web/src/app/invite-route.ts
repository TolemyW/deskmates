// `#/invite/<token>`: the invitation page, owned by the app shell. It shows before any signed-in
// screen, so it has no guide page; Help never opens on it, and it counts as the landing screen.

import { defineRoutes } from "./routes.js";

declare module "./routes.js" {
  interface RouteMap {
    invite: { name: "invite"; token: string };
  }
}

export const routes = defineRoutes({
  screens: { invite: null },
  segments: {
    invite: (rest) => (rest ? { name: "invite", token: decodeURIComponent(rest) } : undefined),
  },
  shown: () => ({ name: "home" }),
});
