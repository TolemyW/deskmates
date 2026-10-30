// @vitest-environment jsdom
// T0: the Chats navigation entry and the chat screen for the landing and thread addresses.

import { MessageSquare } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { feature } from "./feature.js";
import { ThreadScreen } from "./thread.js";

describeNavEntry({
  folder: "chats",
  feature,
  group: "talk",
  order: 10,
  icon: MessageSquare,
  label: "app.nav.chats",
  english: "Chats",
  href: "#/threads",
  currentAt: ["", "#/threads", "#/threads/thr_1"],
  noneCurrentAt: ["#/nowhere"],
  visibleTo: { manager: true, member: true },
});

const api = STUB_CONTEXT.api;
describeRender("chats", [
  ["", ThreadScreen, { api, threadId: undefined, messageId: undefined }],
  ["#/threads", ThreadScreen, { api, threadId: undefined, messageId: undefined }],
  ["#/threads/thr_1?message=m_1", ThreadScreen, { api, threadId: "thr_1", messageId: "m_1" }],
]);
