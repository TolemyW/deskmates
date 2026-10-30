# Evidence-backed recheck fixture

This owner-authorized functional check uses an isolated Gateway, database, Docker workspace
and the configured real cheap model. It must never target the stable database. The bounded
fixture seeds three two-day-old notes: one with no fresh support, one supported by a fresh
shared statement, and one contradicted by a fresh shared statement. A private source supports
the first note as a privacy canary; it must not enter the frozen input.

Create a workspace with `defaultBot: false`, one bot with `welcome: false`, and memory settings
`{recheckDailyLimit: 3, organizeDaily: false}`. Store their normal API responses as `workspace`
and `bot` in `strict-state.json` under the authorized isolated lab root. With the test Gateway
drained, run `node seed.mjs <lab-root>`. The script refuses a stable path or an existing receipt.
It appends explicit synthetic fixture rows through the normal stores and does not dispatch
bot messages. Source transfers require an inventory and hashes excluding secrets and dependencies.

Resume only the isolated Gateway. Let its actual periodic sweep queue the tool-free recheck;
do not manually post another task, retry a verdict, or modify a note to select a result. Archive
all run configs, model replies, events and token receipts, including failed attempts. Check:

- The unsupported note stays at its original version, without `lastConfirmedAt`, verdict unclear.
- The supported note gains exactly one confirm version attributed to the real model run; its
  quote, source id, SHA-256 and source time match the policy-version-2 frozen input.
- The contradicted note stays unchanged and enters the existing possibly-stale human queue.
- The private canary never appears in any frozen activity/evidence.
- Trust, fact bodies and scopes remain unchanged; no second same-version job is submitted.

Drain the Gateway after the bounded job settles and retain the preview and ledgers. Capture
usage for every workspace/run, with missing usage marked unknown. This is seeded-age functional
validation, not natural ageing, broad semantic accuracy, a paired strategy comparison or release
acceptance. Results belong in `docs/design/goal-first-real-model-results-2026-10-21.md`.
