// The message board: every role sees it, Guests included (ADR-0022 amendment 6 W10).

import { Megaphone } from "lucide-react";
import { defineFeature } from "../../app/feature.js";
import { readableBy } from "../../app/routes.js";
import { BoardScreen } from "./board.js";
import { boardHref, routes } from "./route.js";

export const feature = defineFeature(routes, {
  nav: {
    group: "talk",
    order: 50,
    icon: <Megaphone size={18} />,
    label: "board.nav",
    href: boardHref,
    active: (route) => route.name === "board",
    visible: readableBy("board.read"),
  },
  render: (_route, { api }) => <BoardScreen api={api} />,
});
