# M2 Web interaction test handoff

Date: 2026-09-23
Candidate branch: `codex/web-interaction-closeout-20260923`
Implementation commit: `94463e4`
Development base: `1358fcb`
Status: Development checks are separate from independent browser acceptance.

## Isolation and source

Keep any ongoing B1-B5 acceptance campaign on its existing frozen revision. Create a new
worktree from implementation commit `94463e4` and record `git rev-parse HEAD` before
starting. Do not reset, switch or merge into an active tester's checkout. A merge is not needed
for testing this branch.

Use a separate Gateway database/data directory, operator and sandbox ports, Web port, and
container/image/volume/network names if a real workspace is needed. Do not reuse a development
or acceptance database. Configure the Web proxy for the isolated operator port. Keep credentials
out of screenshots, reports and tracked files; a real model is not required for these checks.
Do not rebuild or retag another tester's image. Most cases need only the Web/Gateway and seeded
records; WEB-06 is the real noVNC/container exception.

## Browser checks

| Finding | Scenario | Required result |
|---|---|---|
| WEB-01 | Open run A, navigate directly to B, delay A's requests until after B loads | Title, usage, events, status and errors all belong to B |
| WEB-02 | Delay send A, type B before A completes; repeat with A failing; navigate away/back while pending | B survives; failed A remains recoverable without replacing B; thread drafts never cross threads |
| WEB-03 | Run fails/timeouts/cancels without a final bot reply; refresh the conversation | Visible outcome and reason with a working run-detail link; no unexplained disappearance |
| WEB-04 | Keep pending approval visible, disconnect its SSE, decide it in another tab, reconnect | Pending card and badge disappear; late pending GET cannot regress a streamed decision; a 409 click loads the current decision |
| WEB-05 | Starting with one populated workspace, add another bot, choose model overrides, form a group, then create a second workspace | All steps available through the UI; selection stays in one workspace; overrides persist and clearing restores configured defaults |
| WEB-06 | Take over, navigate away/back or reload/reconnect, then Open screen; also test a blocked popup | Fresh authenticated noVNC access works without handback/retake; fallback link usable; lock remains held; SSE reconnect reconciles handback from another tab |
| WEB-07 | Edit doc A then B then return; edit memory then reload; cause a version conflict; navigate away/back | Dirty selection/reload offers Keep editing or explicit discard; route navigation retains drafts; latest server version can be compared and adopted as save base without replacing local text; no stale save to wrong bot/document |
| WEB-08 | Wrong credential, unavailable Gateway, then successful connection; rotate credential while SSE is down | Wrong token never opens shell/streams; offline is distinct; later 401 closes streams and offers reconnect; transient outage keeps local state |

For knowledge and memory, confirm publishing is still explicitly reviewed, exports contain the
intended local text, and conflict actions do not silently overwrite a newer server version.
Draft retention is in-memory within one login. Reload, disconnect and credential expiry clear the
session; do not assume persistent autosave. For screen recovery, also verify password absence
from registry responses, SSE, database and URL query parameters; the explicit access response
must use `Cache-Control: no-store`. Record actual noVNC handshake results, not just a page load.

## Completed development checks

The implementation passed backend and Web type checks, the integrated Web suite (14 files /
104 cases), the production Web build, Gateway takeover checks (9 cases), and operator
authentication route checks (3 cases). Biome passed on the 29 changed TS/TSX/CSS files. These
are deterministic development checks, not real-browser or noVNC acceptance.

The isolated source can be checked with:

```sh
npm run typecheck
npm run typecheck -w packages/web
node_modules/.bin/vitest run packages/web/src
node_modules/.bin/vitest run packages/gateway/src/api/takeover-routes.test.ts packages/gateway/src/api/operator-auth.test.ts
npm run build -w packages/web
```

These checks have already passed; rerun only if the candidate changes or local setup requires
it. The remaining work is the browser scenario table above, especially real noVNC access and
popup handling. No real model call is necessary to exercise these interactions.

## Evidence and completion

Record source revision, browser, isolated ports, each scenario's result, reproduction steps and
screenshots for failures. Use the earlier review's WEB-01 through WEB-08 identifiers. Screen
mockups in the review are explanatory diagrams, not evidence of an actual browser execution.

This handoff covers the Web closeout only. It does not rerun or conclude B1-B3 reliability,
B4 network isolation, B5 model/strategy acceptance, automatic vision fallback, or governed CLI
work. Do not launch a large model campaign merely to validate these interface changes.
