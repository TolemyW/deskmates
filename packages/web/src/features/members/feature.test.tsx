// @vitest-environment jsdom
// T0: the People navigation entry, which only Owners and Admins see, and its screen; a Member
// at the same address gets Chats.

import { UserCog } from "lucide-react";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { ThreadScreen } from "../chats/thread.js";
import { feature } from "./feature.js";
import { MembersScreen } from "./members.js";

describeNavEntry({
  folder: "members",
  feature,
  group: "operate",
  order: 40,
  icon: UserCog,
  label: "app.nav.people",
  english: "People",
  href: "#/members",
  currentAt: ["#/members"],
  visibleTo: { manager: true, member: false },
});

describeRender("members", [
  [
    "#/members",
    MembersScreen,
    {
      client: STUB_CONTEXT.members,
      tenantRole: "owner",
      tenantName: "Tenant",
      userId: "usr_1",
      ssoProviders: [{ id: "sso_1" }],
    },
  ],
]);

describeRender(
  "members",
  [
    [
      "#/members",
      ThreadScreen,
      { api: STUB_CONTEXT.api, threadId: undefined, messageId: undefined },
    ],
  ],
  false,
);
