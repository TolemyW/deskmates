# M3 schedule interaction and next-fire repair

Date: 2026-10-03 (Asia/Taipei). Status: selected mechanical interaction verified;
full M3 remains in progress. No commit, tag or deployment. Stable services were
not used. This check used local loopback listeners and a private fresh database.

## Problem and change

An actual built browser page kept showing a past next occurrence after the
schedule had fired. `BotSchedules` calculated from `new Date()` only when some
other action caused a render. Leaving the page open did not advance that display.

`packages/web/src/screens/bot-schedules.tsx` now refreshes its display clock at
minute boundaries and when the page becomes visible after suspension. It
re-aligns the timer and clears the timer/listener on unmount. Draft content is
not changed by the refresh. This is a UI correction; the Gateway timer,
five-field cron contract, overlap policy and array-position identity are unchanged.

Two regression cases fail before the repair and pass after it: an elapsed minute
must advance the next occurrence without losing a draft, and a resumed visible
page must show a future occurrence. The original three component cases still
pass. Component/cron selection: **15 pass**, zero fail/skip. Whole-project T0/T1:
**2458 pass**, zero fail/skip. Backend/acceptance and Web typecheck, lint and Web
production build pass. Standalone strict TypeScript checking covers the spike.

## Actual browser and timer evidence

`spikes/m3-schedules-browser-20261003/fixture.ts` runs the actual Gateway with
separate sandbox/operator listeners, SQLite and the real production CronRunner's
wall-clock timers. It serves the built UI. Only the sidecar is synthetic, supplied
by FakeProvider over the real internal HTTP routes. No direct `cron.tick`, fake
clock, real SDK, Docker or model is used for this interaction.

The first observation (`work-01`) verifies add/save and unsaved-draft retention
across switching two bots. It reproduces the stale display while the real
scheduled background run fires at 16:59 UTC. The held first round causes real
skip logs at 17:00 and 17:01 UTC. Its stdin was closed because the launcher did
not allocate a PTY; a read-only process inspection identified the exact fixture
PID, which received SIGTERM. It releases the round, drains, saves its terminal
snapshot and exits zero. That receipt and the stale screenshot remain retained.
The entry URL was also corrected from `#/management` to the observed `#/manage`;
the first browser used the visible navigation link to reach the page.

The post-repair observation (`work-02`) uses a PTY, a fresh database and the new
bundle. Its sequence is:

| UTC time | Observed behavior |
| --- | --- |
| 17:02:53 | Browser has saved `* * * * *` / `SCHEDULE_V1_SYNTHETIC`; next occurrence is 01:03 GMT+8 |
| 17:03:00 | Real timer creates/executes one background run with V1; the synthetic first round is held |
| 17:03:26 | With no edit/reload needed, browser now shows 01:04 GMT+8; screenshot and DOM receipt retained |
| Before 17:04 | Browser saves V2; database contains V2, while the running run's immutable trigger remains V1 |
| 17:04:00 | Exactly one overlap skip is appended to that running run, with no second exec or queued round |
| 17:04:33 | First round is released through fixture stdin and succeeds |
| 17:05:00 | The next wall-clock round executes with V2 and succeeds |
| 17:05:44 | Browser removes/saves the schedule; reload still shows no scheduled instructions |
| After 17:06 | Database and provider still have exactly two successful runs, with both bots' cron arrays empty |
| 17:06:20 | Fixture stops cron, drains, saves the final ledger snapshot, closes listeners and exits zero |

The final runs are `run_221876131a45417faecf14032244a52a` (V1) and
`run_95574a21d4d745edb32f6f40ef63bcfe` (V2). Both are background/cron runs and
record `cronTimeZone: Asia/Taipei`. Configured model names are test labels; no
model was called, and empty synthetic usage is not evidence of real token cost.

Independent post-stop HTTP probes return ECONNREFUSED for both operator ports
53802 and 54263. Both execution handles are terminal with exit zero, and the
browser inventory is empty. Raw private fixture databases remain as evidence;
they are not production data and are not transferred or committed.

## Bindings and limits

Repaired component SHA-256:
`26365e5c591dc046df7f82a4f5a2ae46851bf80489bac429ff81ff8830d2bb2f`.
Built main bundle `index-Do1K6IeU.js` SHA-256:
`8425008865baa913d1c781af13dc276881e5d0364919b61d57f290df455ea118`.
Post-repair terminal receipt SHA-256:
`4fa69a1c85439502a4940669b46d8a49f1cca92596711ddad94bf7fedac3489c`.
`work-02/verified-binding.json` additionally binds the fixture, regressions,
Gateway cron/startup source, built index, UI observations and test reports.

This covers the adopted schedule add/edit/remove interaction, one selected
timezone and minute transition, draft retention, real timer dispatch and overlap
policy using synthetic completion. It does not prove model task delivery,
Docker execution, DST/timezone edge behavior, Gateway process-restart acceptance
or a new latest full T2 gate. Existing deterministic cron tests retain their
own clock/restart/idempotency scope. No pause/run-now or per-schedule timezone
feature was added. Remaining full M3 gates stay visible in the evidence matrix.
