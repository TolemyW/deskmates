# Analytics (ADR-0046 decision 8 and amendment 1)

The operator UI has no analytics screen of its own. Run observability is read in Grafana
(`images/grafana`, run by `stable.sh grafana`), and the UI only links there. Grafana is on the
UI's own origin: the Gateway relays `/analytics/` to it for the root's own session
([analytics relay](../../gateway/docs/analytics-relay.md)), so there is no second sign-in.

## Where the address comes from

`GET /api/config` returns `analyticsUrl`: `/analytics/` when the Gateway has
`OBSERVABILITY_GRAFANA_URL` (Grafana's loopback address, which the web never sees), null when it
is empty. `features/analytics/analytics-url.ts` asks once per API client (`loadAnalyticsUrl`,
`useAnalyticsUrl`); a failed request is asked again on the next mount rather than remembered as
"not configured".

## The navigation entry

`features/analytics/feature.tsx` declares an external navigation entry (`ExternalNavEntry` in
`app/feature.ts`): System, after Costs, label `app.nav.analytics`. It is external to the UI's own
routes, not to its origin. The shell draws an external entry as a link that opens in a new tab (`target="_blank"`, `rel="noopener noreferrer"`), is never
the current page, carries no badge, and is named "Analytics (opens in a new tab)"
(`app.nav.external`). While the address is null the link is not drawn at all.

Who sees it: the root, like `GET /api/observability/status`. The check is the role action
`observability.read` in `@deskmates/contracts` `ROLE_ACTIONS`, whose route is the status route,
so `role-actions.test.ts` in the Gateway fails if the two disagree. Grafana shows every workspace,
which no workspace role covers.

The feature owns no route (`route.ts` is an empty module); its folder exists for the entry, the
run link and their strings (`analytics.*`).

## The run drawer link

The run drawer's header shows "Open in Analytics" next to "Open conversation" when the address is
set and the session may take `observability.read`. It opens the agent runs dashboard with its
`run` variable set, `/analytics/d/deskmates-agent-runs/agent-runs?var-run=<run id>`, whose
"One run" section reads only that run. The uid, slug and variable are `RUN_VIEW`;
`analytics-url.test.ts` checks them against the committed
`observability/grafana/sqlite/dashboards/agent-runs.json`, which
`packages/observability-dashboards` generates.

Both still open a new tab (amendment 1 decision 16): Grafana is a whole-page application with no
way back into the operator UI, and a run opened from the drawer should not discard the drawer.
The browser's Deskmates session admits the tab to the relay; another person, an Owner included,
gets 403 there even with the address typed in.

In development, Vite proxies `/analytics` to the operator listener beside `/api` and `/auth`
(`vite.config.ts`, `vite-config.test.ts`).

## Tests

- `app/navigation.test.tsx`, "an external entry: Analytics": the root sees the link to
  `/analytics/`, in a new tab, never current; hidden without the address and from an Owner
  who is not the root.
- `features/analytics/feature.test.tsx`: the entry's place, icon, label and root-only visibility.
- `features/analytics/analytics-url.test.ts`: the run view address, its agreement with the
  generated dashboard, one request per client and a retry after a failure.
- `features/analytics/analytics-run-link.test.tsx` and the `runs/run.test.tsx` case: the drawer
  link for the root with the address, and its absence otherwise.
