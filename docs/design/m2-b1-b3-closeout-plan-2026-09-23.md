# B1–B3 consolidated closeout

Date: 2026-09-23. Starting revision: `9eaa0cb`.
Scope: the user requests one coordinated cleanup of outstanding B1, B2 and B3
items, with independent Sol-medium subagents and isolated verification. Work stays
in `codex/m2-foundation-20260922`; the active main app is not a test target.

## Closure inventory

Historical failed trials remain evidence, not automatically current defects.
Existing later fixes and passing checks must be reconciled against the original
requirements before reopening an item. B1 messaging/idempotency and B3 group,
chief, caps, takeover and UI have passing focused evidence. Their shared B2
X02/X03 dependency remains open: prior K5 observed one concurrent failure in ten
pairs; the latest diagnostic has failing solo controls and therefore cannot
estimate concurrency interference.

| Owner | Bounded responsibility |
| --- | --- |
| Group subagent | Audit B1/group/chief requirements against current code and evidence; repair demonstrated routing/acceptance defects and verify affected tests |
| Browser subagent | Audit B2 target, approval and takeover behavior; investigate stale refs/capture waits without weakening fences |
| Golden-site subagent | Diagnose actual X02 traces and observable UI requirements; repair demonstrated page/fixture defects without changing target sets or task success criteria |
| Integrator | Reconcile all open items, isolate the model-latency experiment, integrate justified fixes and run final regression/acceptance gates |

The three existing subagents keep their Sol-medium configuration. They do not
start competing Docker/model jobs or edit overlapping files. The integrator
coordinates those resources. No main checkout, shared image tag, application
port/database or existing application container is changed.

## Fixed diagnostic sequence

1. Run the unchanged ticket fixture with the configured cheap model
   `glm5.3-flash`, the existing timing image, baseline completion instructions,
   tab-v1, 300-second deadline and 35-turn cap. This smoke changes the primary
   model only. Preserve all eight outcomes and raw traces, including failures.
   The previous GLM run is historical context, not a contemporaneous paired
   model-superiority comparison.
2. Diagnose any failed solo task before allocating a full concurrency matrix.
   Fix only a demonstrated code/fixture defect; a model-context change is a
   separately versioned experiment with unchanged state oracles. Do not bundle
   model, completion prompt and origin coordination changes into one result.
3. Once the candidate passes the smoke, run a predeclared fresh K5 X02/X03 matrix
   (40 runs) on frozen inputs. No rerunning failed repetitions to replace them.
   Report all solo and concurrent outcomes, unclassifiable pairs, interference,
   strict tool diagnostics, timing, attribution and unrelated-state checks.
   A zero observed interference rate is not a population reliability guarantee.
4. Recheck named group/chief, X01, takeover, parked approval and B1 messaging on
   the final selected runtime/model, with deterministic caps/target regressions.
   Model selection remains test configuration until explicitly deployed; passing
   on Flash cannot be reported as passing on GLM or on the running main app.
5. Produce one current-status record linking each original B1–B3 requirement to
   evidence or a concrete unresolved blocker. Separate canonical acceptance from
   optional protocol/format diagnostics without removing either. Full M2, B4/B5,
   long-lived resource sizing and retained-tab lifecycle are separate scopes in
   the original plans and are not silently included or declared complete.

## Acceptance integrity

No deadline/turn increase, expected-ID shortcut, hidden retry, broad state reset
while runs are active, or relaxed write/target/approval/takeover assertion is
permitted. `origin-v2` and `verified-stop-v1` remain opt-in experiments. Passing
unit tests or collecting more telemetry alone does not close the business gate.
A proposed strategy adoption still requires the measurement protocol; this batch
may establish specific functional acceptance without claiming general superiority.

Source/image/model/task provenance must accompany every series. Commit design
records separately from code. Report precisely whether completion is implemented,
verified in isolation, merged, or deployed; these are separate states.

## Bounded inline-snapshot candidate

The trace audit found no golden-site defect: all targets are discoverable in one
filter result. Five recorded reference errors are scoped snapshots using a ref
invalidated by navigation or a form submission. Explicit snapshot delivery also
requires another model turn after many actions. Prototype `inline-v2` behind an
independent snapshot-mode knob, retaining `explicit-v1` as the default.

After a successful page-changing action, the proxy may perform one bounded,
unscoped, read-only snapshot and append the current page text to the original
result before its existing untrusted wrapper. The original action is never
replayed or represented as unexecuted merely because this supplemental read fails.
Target identity, human takeover epochs, approval and origin fences remain; an
invalidated result must disclose that an already dispatched action may have
completed. Keep automatic MCP file snapshots disabled. Record the mode at run
creation and pass it unchanged on resume, with separate snapshot timing.

This is an intentional context/driver strategy candidate, not a claimed framework
bug fix. First establish actual MCP delivery and race/cancellation regressions with
scripted upstream, then compare same-image explicit/inline arms on the same model,
completion instructions, tasks and limits. Model comparison and snapshot comparison
must remain separate. Do not enable it by default based on one passing sample.

## Background capture diagnosis

The complete Flash smoke adds a concrete runtime hypothesis: the background run
spent 49.0 seconds in 14 screenshot RPCs, versus 1.22 seconds in its peer's 15
RPCs. Six background captures reached the existing five-second boundary. Successful
captures retained the correct target. The proxy and pinned MCP both use a
five-second bound, which explains different timeout diagnostics but does not itself
explain why background captures are slow.

Prepare a separate no-model, two-tab probe under `spikes/m2-browser-capture` while
the frozen snapshot model comparison runs. Execute it only after that comparison
ends, so diagnostic workload does not contaminate either arm's timing. Preserve
fixed page content/targets, capture outcomes, raw images and per-call durations.
Compare ordinary current behavior with verified foreground capture; if the pinned
Chromium/Playwright source supports a background-throttling flag experiment, test
that as a separate variant. Keep the same timeout and do not bypass screenshot,
target, takeover, egress or approval fences.

A probe success alone does not authorize claiming the business gate closed. Any
runtime correction needs its own frozen image, meaningful deterministic safety
regression and configured-model smoke before fresh K5. Do not change the in-flight
comparison's source/image/input or pool its results with a later capture fix.
