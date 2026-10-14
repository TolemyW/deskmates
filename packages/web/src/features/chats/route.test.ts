// @vitest-environment node
// T0: the chats routes, and the landing screen every unknown address falls back to.

import { describeRoutes } from "../../app/testing/route-expectations.js";
import { routes, threadHref, threadsHref } from "./route.js";

describeRoutes({
  owner: "chats",
  module: routes,
  screens: { home: "getting-started", threads: "chats-and-groups" },
  addresses: [
    ["", { name: "home" }],
    ["#", { name: "home" }],
    ["#/", { name: "home" }],
    ["#//threads", { name: "threads" }],
    ["threads", { name: "threads" }],
    ["#/nope", { name: "home" }],
    ["#/threads", { name: "threads" }],
    ["#/threads/", { name: "threads" }],
    ["#/threads/thr_1", { name: "threads", id: "thr_1" }],
    ["#/threads/a%2Fb", { name: "threads", id: "a/b" }],
    ["#/threads/thr_1/extra", { name: "threads", id: "thr_1" }],
    ["#/threads/thr_1?message=msg_2", { name: "threads", id: "thr_1", messageId: "msg_2" }],
    ["#/threads/thr_1?other=1", { name: "threads", id: "thr_1" }],
    ["#/threads/thr_1?message=", { name: "threads", id: "thr_1" }],
    ["#/threads?message=1", { name: "home" }],
  ],
  hrefs: [
    [threadsHref(), "#/threads", { name: "threads" }],
    [threadHref("thr_1"), "#/threads/thr_1", { name: "threads", id: "thr_1" }],
    [
      threadHref("a/b", "m 1"),
      "#/threads/a%2Fb?message=m%201",
      { name: "threads", id: "a/b", messageId: "m 1" },
    ],
  ],
  viewed: [
    ["", "home", "getting-started", "home", "getting-started"],
    ["#/threads/thr_1", "threads", "chats-and-groups", "threads", "chats-and-groups"],
  ],
});
