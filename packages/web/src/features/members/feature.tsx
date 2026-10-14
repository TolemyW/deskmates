// People: Owners and Admins only. For a Member the route module shows Chats instead, so this
// screen never renders for one.

import { UserCog } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { MembersScreen } from "./members.js";
import { membersHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "operate",
    order: 40,
    icon: <UserCog size={18} />,
    label: "app.nav.people",
    href: membersHref,
    active: (route) => route.name === "members",
    visible: (roles) => roles.manager,
  },
  render: (_route, { members, session }) => (
    <MembersScreen
      client={members}
      tenantRole={session.tenant.role}
      tenantName={session.tenant.name}
      userId={session.user.id}
      ssoProviders={
        session.tenants?.find((tenant) => tenant.id === session.tenant.id)?.ssoProviders ?? []
      }
    />
  ),
});
