import type { ThreadId } from "@deskmates/contracts";
import { MessageSquare } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { routes, threadsHref } from "./route.js";
import { ThreadScreen } from "./thread.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "talk",
    order: 10,
    icon: <MessageSquare size={18} />,
    label: "app.nav.chats",
    href: threadsHref,
    active: (route) => route.name === "home" || route.name === "threads",
    visible: readableBy("threads.list"),
  },
  render: (route, { api }) => (
    <ThreadScreen
      threadId={route.name === "threads" ? (route.id as ThreadId) : undefined}
      messageId={route.name === "threads" ? route.messageId : undefined}
      api={api}
    />
  ),
});
