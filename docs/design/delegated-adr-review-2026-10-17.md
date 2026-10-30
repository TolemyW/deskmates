# Delegated review of the open Proposed ADR decisions (2026-10-17)

On 2026-10-17 the owner told the coordinator to handle every ADR, amendment and engineering
choice still Proposed and waiting for the owner ("你来处理"). This record lists what was found, the
verdict on each decision, why, and what follows. ADR-0017, ADR-0047 and ADR-0048 were out of
scope (other sessions own them).

Rules applied to every verdict:

- A decision is accepted only when it is consistent with AGENTS.md and the accepted ADRs, and its
  implementation and tests were read. Where the text and the code disagreed, or the text no
  longer matched a later owner ruling, the text was changed in the ADR ("accept with change").
- Accepting a design never turns a strategy knob on. Every knob that changes SOUL, prompts,
  tools, routing, approval rules, retrieval or the runtime keeps its default, and changing it still
  needs the paired `evals/compare.ts` protocol.
- Accepting a design is not passing a live gate. Real-model, T2, stable-host, visual and
  measurement gates that were pending stay pending, and each status line names them.
- Each ADR change is its own commit; status lines read "Accepted under owner delegation
  (2026-10-17)" (a top-level header uses the form "Accepted (under owner delegation, 2026-10-17
  …)", which `scripts/docs-consistency.mjs` accepts).

## What was found

Proposed parts, by ADR: 0002 (amendment 4 B3 list and B4 to B7, amendment 5, amendment 6 D4
order), 0004 (amendment 1), 0005 (amendment 6), 0006 (header, amendments 4 and 5), 0011 (A9,
A21), 0013 (whole ADR), 0014 (A4, A5 cancel roles and quota, A6, A7 decisions 44 and 46), 0021
(amendments 1 and 3), 0022 (whole ADR, the implementation choices, amendments 3, 4, 5 and 7),
0023 (amendments 1, 2, 3 and 5), 0024 (amendments 2 and 3), 0026 (amendment 1's engineering
choices), 0032 (whole ADR), 0034 (decisions 2, 5 and 7), 0036 (whole ADR), 0037 (whole ADR),
0039 (decisions 7 and 8), 0040 (engineering choices of decisions 2 to 5 and amendment B), 0041
(decision 2 and decision 6's defaults), 0042 (whole ADR, and the question of new failure
classes), 0043 (engineering choices), 0044 (whole ADR), 0045 (whole ADR), 0046 (whole ADR and
amendment 1).

Named in the request but holding nothing Proposed: ADR-0012 (accepted 2026-10-10; "originally
proposed" is history) and ADR-0018 (accepted 2026-10-10). ADR-0027 line "proposed follow-up" is a
follow-up note, not a decision.

## Verdicts

| ADR | Decision | Verdict | Reason | Follow-up |
|---|---|---|---|---|
| 0002 | Am. 4 B3 protected list, B4 to B7 | Accept (as amended by am. 6) | Deterministic protected list checked before any model; reviewer is a recorded, tool-free sidecar job, so the Gateway still calls no model; verdict bound to the frozen action hash; implemented and tested | Reviewer-vs-human paired measurement (agreement, false-negative rate) pending; distinct reviewer model not accepted, left for later |
| 0002 | Am. 4 "not decided here" paragraph | Accept with change | Said amendment 3 was still Proposed; the owner signed it on 2026-10-17; cron-prompt tracing is answered by am. 6 D3 | none |
| 0002 | Am. 5 C1 to C6 (`effects-v1`) | Accept with change, behind the knob | A guard rail that stops tool choice lowering a tier; default `name-v1` byte for byte; change: C6's expected effect and comparison are per approval mode, since am. 6 made browser actions reviewable | Switching needs C6's paired run and the owner lifting the #78 deferral |
| 0002 | Am. 6 D4 order (stored deny before `approve_all`) | Accept | Follows the broker order tier, rule, mode, expiry; a stored deny is a person's explicit answer | none |
| 0004 | Am. 1 decisions 10, 11, 13 | Accept | The decisions ADR-0038 left standing; match the code | Session-carry copy (ADR-0038 d9) unverified on a live host |
| 0005 | Am. 6 decisions 43 to 52 (`round-v1`) | Accept, behind the knob | Keeps owner-v1's facts, triage is a sidecar model job, falls back to today's routing, loop breaker unchanged; implemented and tested | Default stays `owner-v1`; decision 52's paired evaluation not run or authorized; `CHEAP_MODEL` must serve triage first |
| 0006 | Header (decisions 1 to 9) | Accept with change | Header said "implementation in progress"; it now names the owner's 2026-09-23 activation and what is pending | Milestone network-isolation acceptance pending |
| 0006 | Am. 4 decision 10 (session cookie, no URL credential) | Accept | Shipped with ADR-0022 P1, tested | none |
| 0006 | Am. 5 decisions 11 to 15 (host resources) | Accept | Read-only listing; root-only, audited, confirmed actions refused while a run or sidecar is live | Stable-host acceptance and T2 rows pending |
| 0011 | A9 recency order | Accept | Only platform clocks; old arrivals stored closed, so redelivery never rolls a fact back | none |
| 0011 | A21 landing view | Accept | Keeps the built entry list; presentation only | Owner may still pick topic grouping |
| 0013 | Decisions 1 to 9, amendments 1 to 3 | Accept with clarification | Credentials stay on the host, connections scoped per workspace, writes L2; module and tests exist; clarified: approvals follow the workspace approval mode, `destructive` never lowered | No provider adopted; OAuth apps, test accounts, transit storage and egress-proxy traffic pending |
| 0014 | A4 (Files lists verified results and inputs) | Accept | Owner-confirmed contract, implemented | none |
| 0014 | A5 cancel roles, opt-in quota | Accept | Uploader, Admin or Owner cancels; quota off unless set | none |
| 0014 | A6 preview controls and entry points | Accept | Within A3's accepted render policy | Desktop and 390 px visual checks pending |
| 0014 | A7 decisions 44 and 46 | Accept | 44 publishes nothing and offers only decision 1's download; 46 applies the private-chat rule to every caller, root and operator credential included | none |
| 0021 | Am. 1 (acceptor is the signed-in person) | Accept | Shipped with P1 sessions | none |
| 0021 | Am. 3 A3a to A3m | Accept | Owner-confirmed contracts; missed ticks skipped like ADR-0029 d11; no budget bypass | Runtime and real-model task gates pending (M4 status) |
| 0022 | Decisions 1 to 6, single-tenant scope | Accept with change | Sessions, OIDC and per-workspace roles shipped and tested; change: decision 2's tenant roles marked superseded by am. 6 | Second tenant not accepted: E2E-02, migration rehearsal and real SSO must pass and the owner reopen multi-tenancy |
| 0022 | Implementation choices (JWKS always, back-channel logout, persisted takeover holder, limits, JIT target) | Accept | Each tightens or clarifies; concurrency limits since removed by am. 5 | none |
| 0022 | Am. 3, 4, 5 engineering, 7 | Accept | Implemented "for review" with tests; consistent with am. 6 roles | Real-model status-inquiry quality unmeasured |
| 0023 | Am. 1 decisions 4 to 10 | Accept | Image transport observable, probe evidence honest, proposals never self-apply | Real-model and T2 image path pending |
| 0023 | Am. 2 decisions 11 to 14 (both proposed points of 11) | Accept | Only a probe that saw a wrong answer withholds; nothing unproven blinds a model; no notice without evaluation | Measure `wrong_answer` share on models known to see; T2 pending |
| 0023 | Am. 3 decisions 15 to 17 | Accept | Closes the PDF and connector image paths; PDF text answered by ADR-0040 | T2 of a withheld PDF `Read` pending |
| 0023 | Am. 5 decisions 20 to 24 | Accept, knobs off | 20 to 23 change no byte the model reads; 24's knobs are empty by default | Paired before/after window for any knob value; not run |
| 0024 | Am. 2 decisions 11, 12 | Accept | Presentation and retry guard only | none |
| 0024 | Am. 3 decision 13 | Accept (status line added) | Suppresses a false diagnostic only | none |
| 0026 | Am. 1 queued-work hold, webhook 409 | Accept | Pause stays lossless and reversible | none |
| 0032 | Decisions 1 to 10 | Accept with change | Implements the owner's rulings, tested; change: decisions 1 and 7 name an Owner or Admin of the workspace, as the route policy already enforces | Per-run overshoot on a real model unmeasured; decision 10's follow-ups not taken |
| 0034 | Decisions 2 (legacy names), 5 (last activity), 7 (routes) | Accept | Preserve data, leak no private chat, built and tested | Visual checks pending |
| 0036 | Decisions 1, 3, 5, 6, 9 | Accept | What ADR-0038 left standing; one team convention per workspace | none |
| 0036 | Decision 7 | Accept with change | Contradicted ADR-0038's directory guard; now names it as the one reader | none |
| 0036 | Decision 8 | Accept with change | `mode` default is the owner's ADR-0038 ruling; `laneNotice` stays off | `laneNotice` paired campaign not authorized |
| 0037 | Decisions 1 to 8 | Accept | Observations only, no behaviour change; added test: a private chat's timeline and reply preview reach only its person | No live latency measurement run or authorized |
| 0039 | Decisions 7, 8 | Accept | Free models stay out of the estimate; config lists upstream ids only | none |
| 0040 | Engineering choices of decisions 2 to 5 | Accept | Gateway-built templates, bounded inputs, untrusted results | Fingerprint comparison for seeing runs on the first configured release; accuracy unmeasured |
| 0040 | Am. B decisions 16 to 24 | Accept | Fixed template, no URL fetch, exclusive create in the bot's directory, L1 matches the effect | Live check against a real image service |
| 0041 | Decision 2 (Gateway calls embed/rerank) | Accept | Numbers only, recorded per call; already the AGENTS.md exception | none |
| 0041 | Decision 6 defaults | Accept as starting values | Used only when configured, off by default | Enabling or retuning is a strategy change; decision 10's paired evaluation not run |
| 0042 | Decisions 1 to 6 | Accept with change | Shipped since v0.7.0 and tested; change: decision 1's list also names `platform_interruption` | Stable corpus check (zero `other`), browser pass, retention setting (owner) |
| 0042 | New failure classes (am. 2 decision 7) | Accept with change, implemented | The 24 v0.7.3 runs need different operator action; `sandbox_unavailable` before the model rules, `sidecar_exit` last so a named cause wins | none (code and tests in this change) |
| 0043 | Decisions 1 to 4 engineering choices | Accept | Runs keep the files and home they started with; hash-only audit | none |
| 0044 | Decisions 1 to 9 | Accept, default unchanged | One `PreToolUse` gate for both runtimes; only the sidecar imports an agent SDK; run token in process | Switching is a strategy change (paired run); T2 on the real Agents SDK and an OpenAI upstream; known gaps |
| 0045 | Decisions 1 to 10 | Accept with change, design only | Tool-mediated use keeps plaintext out of transcripts and is honest about recoverability; changes: decision 2 names Owner or Admin; decision 4 states the approval-mode behaviour (human in `automatic`, thread in `manual`, mode in `approve_all`, origin checks always) | Whole feature not implemented |
| 0046 | Decisions 1 to 10 | Accept with change | One-way, separate store, root-only; change: an external sink needs `OBSERVABILITY_PAYLOADS` set explicitly | Phase 2 and 3 not built; phase-1 acceptance on a live host pending |
| 0046 | Am. 1 decisions 11 to 17 (Viewer, CSRF exemption, Live off, request budget, loopback trust) | Accept | Least privilege; exemption is a fixed list with `Origin` still checked and nothing a Viewer can change; budget is the conservative choice; host processes are already trusted | Measure the request-budget share of one dashboard load on the stable host |

## Accepted decisions not yet implemented

For the coordinator to schedule. Measurements and live gates are listed separately below.

1. **ADR-0045, the whole Vault**: catalog table and routes (Owner or Admin), `vault_list`,
   `vault_fill` with the fixed sidecar fill command, `vault_request` with operator request
   definitions, redaction and capture suppression, the approval-mode behaviour of decision 4 and
   the Vault page's `approve_all` notice, and every row of its Verification table.
2. **ADR-0046 phase 2**: the `postgres` and `forward` sinks, `images/obs-lake`, the four remaining
   dashboards, and the startup refusal of an external sink without an explicit
   `OBSERVABILITY_PAYLOADS` (today both sinks are refused as not bundled).
3. **ADR-0046 phase 3**: decision 9's retrospective (summary vectors, nearest successful runs,
   scored against `run_marks`).
4. **ADR-0013 decision 8**: per-provider adoption smokes; no provider is adopted until its smoke
   exists and passes.

## Pending live gates and measurements (not accepted by this review)

- ADR-0002: reviewer verdicts against recorded human decisions (`evals/compare.ts`); amendment 5's
  C6 comparison per approval mode before any deployment uses `effects-v1`.
- ADR-0005 amendment 6: decision 52's three-arm paired evaluation.
- ADR-0006: milestone network-isolation acceptance; amendment 5 on the stable host.
- ADR-0013: OAuth apps, grants and refresh, the ten actions, transit storage, egress-proxy traffic.
- ADR-0014: A5 and A6 visual checks.
- ADR-0022: E2E-02, migration rehearsal and real-provider SSO before any second tenant.
- ADR-0023: T2 and real-model checks of amendments 1 to 3; amendment 5's paired window.
- ADR-0032: per-run overshoot on a real model.
- ADR-0034: visual checks at 390 px and in both themes.
- ADR-0036: the `laneNotice` campaign (not authorized).
- ADR-0037: the live latency report.
- ADR-0040: fingerprint comparison for seeing runs; live image-generation service.
- ADR-0041: decision 10's paired evaluation (protocol predeclared, not run).
- ADR-0042: the stable host's exported corpus at zero `other`; browser pass; the owner's retention
  setting.
- ADR-0044: decision 8's paired runtime comparison; T2 on the real Agents SDK.
- ADR-0046: phase-1 acceptance on a live host; T2 Grafana image; the request-budget measurement.

## Findings outside the ADR text

- AGENTS.md still calls ADR-0027 amendment 1 "(proposed)", although that amendment's heading says
  owner-decided 2026-10-14. AGENTS.md was not edited in this review; the coordinator or the owner
  should correct it.
- A LAN address of the GPU host appears in tracked files (ADR-0039, ADR-0040 and ADR-0041 context,
  `.env.example`, three Gateway docs and several Gateway tests). AGENTS.md says LAN addresses never
  enter a tracked file and `main` is mirrored publicly; `scripts/public-scan.test.mjs` passes
  because the address is not in its blocklist. A coordinated scrub (a documentation address such
  as `192.0.2.10` in examples and tests) and a blocklist entry are needed; it was not done here
  because it touches shared files other sessions are editing.
