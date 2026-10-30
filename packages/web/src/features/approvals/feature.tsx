// The Attention link carries a badge with the pending count, fed by the same global `approval`
// stream the inbox subscribes to, so a request raised in a thread the operator is not looking at
// is still visible.

import { ShieldCheck } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { ApprovalsScreen, usePendingApprovals } from "./approvals.js";
import { approvalsHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "talk",
    order: 30,
    icon: <ShieldCheck size={18} />,
    label: "app.nav.attention",
    href: approvalsHref,
    active: (route) => route.name === "approvals",
    visible: readableBy("approvals.read"),
    badge: {
      useCount: ({ api, checkConnection }) => usePendingApprovals(api, checkConnection).total,
      name: (t, count) => t("app.nav.attentionPending", { count }),
    },
  },
  render: (_route, { api }) => <ApprovalsScreen api={api} />,
});
