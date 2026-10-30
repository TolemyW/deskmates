# Telegram continuity and deterministic bug fixes — 2026-10-27

## Scope

Owner direction: fix established code defects first, then make Telegram a continuing information
surface for a long-term Agent. No new/reset/stop task controls. Implementation follows ADR-0047
amendment 3. Related private issue numbers: 62, 70, 82; none is closed by offline evidence alone.

## Changes

- `bot_create` preserves the returned bot ID; group creation retains its existing thread link.
- Output examples choose values that pass the actual schema validator, including mixed enums,
  unions, nested required fields and impossible item schemas. When no example can be generated,
  tool help omits the invalid output and explicitly identifies the unavailable example.
- Pending approvals retain their identities across process resumes. Reuse requires the same
  call, kind and full action fingerprint. Drain/restart carry the complete pending set; a decision
  on a non-primary card can resume work. This does not transfer egress approval to a tool action.
- Telegram recovers current-binding conversations from the Gateway, coalesces relay events,
  honors retry delays, rechecks the send gate per chunk and retains inbound failures for retry.
  Current meaningful waits, failure and recovery have deduplicated system notices. Results and
  approval cards use the existing ordered transcript. Last refused/ambiguous sends remain
  visible diagnostics, not successful receipts. No histories are merged between people.
- `/start`, `/help`, `/status`, `/settings` have deterministic handlers. Commands addressed to
  another bot are ignored; literal code entities are not commands. Unknown controls receive
  guidance. Settings use an optional operator-configured HTTPS Web link and existing Web roles.
- Owners/Admins can inspect and synchronize one explicit command-menu scope/language from the
  connection card. The proposed commands are visible. Custom buttons are preserved unless
  explicitly replaced. Menu failure leaves chat running. Lifecycle operations never sync menus.

## Verification

Focused approval/schema/runtime checks: 99 tests passed before Telegram integration. The later
focused channel/menu/permission/schema/drain selection passed 51 tests. Typecheck, lint, documentation consistency and production Web build passed. The full
T0/T1 rerun (`npm test -- --maxWorkers=3`) passed 909 files / 8,511 tests. A final Telegram
selection after the inbound-retention regression and relay cleanup-race fix passed 4 files /
33 tests; the menu UI test also passed. No model or provider network was used.

The first full T0/T1 run passed 8,505 tests and failed four: a stale generated permission matrix,
a missing audit-action migration, and two existing release-script timeouts under concurrent
build/test load. The generated table and audit migration were corrected. The lower-concurrency
full-suite rerun passed, including all 40 release-script tests; no time limit was raised.

Desktop browser verification used the local demo, with no live provider credentials: opened
Telegram management, inspected a legacy menu, synchronized it, and saw only start/help/status/
settings in the returned list. The command target, replacement checkbox and error state were
visually checked. Demo-only wiring found during this check was corrected. This is not a real
phone/menu or live transport acceptance result.

## Remaining evidence

No real model call, paid campaign, stable deployment, container acceptance or real Telegram
account test was run. Live phone-visible menus, provider retention/rate limits and authenticated
settings journeys remain acceptance work. Existing TLS/account, model fallback, bounded-summary
and campaign-delivery findings retain their previous status. Ambiguous external sends can still
repeat; this change does not claim exactly-once provider delivery. Help/status/settings notices
are best effort. Recovery summarizes current run state instead of replaying obsolete transitions.
