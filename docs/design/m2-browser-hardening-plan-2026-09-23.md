# M2 browser follow-up: parallel hardening and acceptance

Starting revision: `1b8654c`, branch `codex/m2-foundation-20260922`.
User requested continued improvement with subagents. Three subagents use
`gpt-5.6-sol`, medium effort; the integrator reviews and validates the combined result.
All edits stay in the existing isolated worktree. No deployment, main checkout edits,
shared image replacement, or restarts of the active application are part of this work.

| Owner | Bounded work | File ownership |
| --- | --- | --- |
| Approval agent | Actual deferred approval and SDK process resume; same stable tab, one side effect, peer unaffected | New M2 browser approval acceptance tests and its spike helpers |
| Interference agent | K=5 paired solo/concurrent dashboard reads, distinguish strict formatting from runtime/semantic failure, retain raw evidence | New interference acceptance test and dedicated spike runner/report |
| Format agent | Diagnose original final-reply mismatch and ensure one format failure does not skip other oracles | Existing browser model smoke test and new pure oracle helper/tests |
| Integrator | Runtime correctness review, browser target restore/capture fixes, integration, image build, real-model matrix, docs/commits | Production sidecar files and their tests, shared verification/report |

## Conditions

- Do not relax an exact-answer oracle to make an existing failure pass. Preserve
  strict failures separately from browser runtime evidence. Do not change SOUL or
  production prompting based on one stochastic result.
- Solo and concurrent measurement use identical tasks and model/strategy. Seed
  distinct KPI values so swapping answers cannot pass unnoticed. Alternate mode
  order and use fresh model sessions. K=5 means 20 runs for two tasks in two modes.
- This read-only dashboard probe is not X02/X03. Their ticket/report routes remain
  unimplemented. Ten paired target observations cannot establish a <=5% interference
  rate or justify changing lock granularity.
- Use separate temporary databases/volumes/ports per suite. Coordinate real-model
  runs centrally so unrelated tests do not add resource pressure to latency data.
- Required validation: affected tests and root typecheck, full T0/T1 integration,
  isolated real browser/SDK tests, configured-model runs where relevant. Record
  source/image IDs and failed trials. Documentation changes get their own commit.
