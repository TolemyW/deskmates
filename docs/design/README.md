# docs/design

| File | Status | Read it for |
|---|---|---|
| [m4-tenant-auth-sso-plan-2026-10-05.md](m4-tenant-auth-sso-plan-2026-10-05.md) | proposed; not implemented | tenant isolation, persistent sessions, external SSO and migration |
| [m4-tenant-auth-sso-test-plan-2026-10-05.md](m4-tenant-auth-sso-test-plan-2026-10-05.md) | proposed; tests not run | positive/negative boundary matrix, migration and phase gates |
| `m3-owner-scope-closeout-and-m4-backlog-2026-10-03.md` | owner-approved M3 scope closeout; remaining gates moved to M4 | revised closeout, retained failed/unverified gates and integration dependency |
| `design-cogbot-thin-core-v0.3-2026-09-20.md` | canonical | the architecture, as amended by ADR-0004 |
| `test-strategy-2026-09-20.md` | canonical | test tiers, test doubles, fault and security checklists, milestone acceptance |
| `measurement-2026-09-20.md` | canonical | how a change is judged better or worse: paired evals, error bars, fingerprints, replay |
| `benchmark-2026-09-20.md` | canonical | the golden site and the 48-task deskbench suite |
| `s0-spike-results-2026-09-20.md` | record | what was verified with real code on 2026-09-20 |
| `design-cogbot-thin-core-v0.2-2026-09-20.md` | superseded for architecture | sections 10 to 12: scenario feasibility evaluation, still canonical |
| `design-cogbot-thin-core-2026-09-20.md` | superseded (v0.1) | history only |
| `productization-roadmap-2026-10-03.md` | proposal | the path from the current demo to a 1.0 product: assessment, phases, decisions the owner has to make |
| `web-interaction-upgrade-2026-10-03.md` | phase 1 implemented, phases 2 and 3 proposed | the operator UI design system, the conversation screen rebuild, the UI demo tooling and the next two phases |

Each `.md` above has a `.zh.md` twin: the original Chinese draft, frozen at the 2026-09-21 translation. Edit only the English file.

Decisions that amend these live in `../adr/`. Never move, rename or delete a file here; superseded versions stay for history.

