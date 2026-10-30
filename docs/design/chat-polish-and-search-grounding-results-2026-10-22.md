# Chat polish and search grounding results — 2026-10-22

The owner reported a lost frosted scroll transition, a persistent transcript scrollbar,
warning-like routine system messages, missing first greetings for assistant-created bots and
an unfamiliar-model answer that substituted a familiar economic concept. The owner then chose
search on for the reported workspace and requested configured search on by default, with the
switch alongside network settings (ADR-0049 amendment 1).

## Changes and verified behavior

- The latest button floats over the transcript with a computed `blur(16px)`, without a border
  strip or layout-height change. A masked blur/fade softens the transcript's bottom edge; the
  scrollbar becomes transparent after 900 ms of inactivity. Keyboard focus retains a visible
  scrollbar; touch/narrow surfaces retain their hidden native scrollbar behavior.
- Gateway-created teammate receipts and memory outcomes use compact disclosures. Routine
  untrusted writes say Observation recorded, with an explicit explanation that they are
  unverified and excluded from automatic context. Gated and unapplied outcomes keep their
  distinct meaning and a review link. Raw protocol stays available in Tune; approvals and
  unknown system messages do not become routine receipts. The transcript is unchanged.
- Assistant creation now writes the ordinary welcome run in the same transaction as the bot,
  initial SOUL and canonical chat, publishes it and kicks the scheduler. The fake-provider
  integration test proves a single attributable greeting in that chat, with no duplicate
  greeting in the assistant's source chat. Existing delivery/retry behavior is retained.
- Configured search inherits on, explicit off stays off, reset inherits on, no backend stays
  effectively off and existing runs keep their frozen choice. The switch appears adjacent to
  Network policy in Tools & network in Use and Tune. Five locale catalogs and the demo agree.
- New bot runs record `researchGuidance: verify-v1`; older runs and model jobs retain their
  earlier prompts. The guidance asks for exact-name/domain searches, primary-source checks,
  citations, browser fallback and explicit uncertainty instead of familiar-name substitution.
- A zero-result upstream answer with reported engine failures becomes `engines_unavailable`,
  recorded as a failed call without retrying. A clean no-match remains success; useful results
  during partial engine failure remain usable. No arbitrary upstream diagnostic is relayed.

## Runtime observations and limits

The private lab record "Chat polish and search grounding — 2026-10-22" contains the read-only
run diagnosis, synthetic browser fixture, scripts, screenshots and search receipts. The reported
answer had no tool calls and search off; its SOUL permitted browser research. No real model was
run for this change, so guidance compliance and paired quality improvement remain unverified.

The reported workspace was explicitly enabled through the audited operator API. A live backend
check initially returned zero results with timeouts/CAPTCHA; an operator-backed-up settings
change added a working Mwmbl engine and restarted only the search service. The normal query
then returned 36 relevant results, including the official TypeSafe Jev introduction first.
Google CSE also recovered after restart; the observations do not attribute all recovery to the
added engine. Some engines still reported failures. Preserve the operator override across
future search-container recreation. This is a runtime recovery receipt, not a paired search
quality result or a release/deployment acceptance claim.

Local Chromium checks covered light/dark 1280×1000 and dark 390×844. Measured scrollbar reset,
latest-follow behavior, absolute positioning, actual backdrop filtering and no horizontal
mobile overflow passed, with no page errors. Screenshots were inspected. These are actual source
components on synthetic data, not a visual check of a deployed new release.

Typecheck, lint, documentation consistency, the production web build and the full offline
T0/T1 suite are the local verification gate. T2, deployment of source changes and a paid/model
comparison are outside this receipt. Existing milestone gates remain pending.

Final local receipt: the full T0/T1 run completed 8,352 tests across 888 files. 8,351 passed;
its sole failure was the documentation checker reading ADR-0049 while its new verification
row was still being edited. After fixing the table, the owning documentation suite passed all
33 tests and `docs:check` passed. Typecheck, lint, the web build and visual assertions passed.
No clean single-invocation full-suite pass is claimed for that run; all final checks have
passing receipts, including the corrected documentation check.
