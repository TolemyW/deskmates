# M1/M2 remaining feature development — 2026-09-23

Status: implementation and bounded development checks complete in `codex/m1-m2-feature-closeout-20260923`, based on `8d4f551`. Main, running services and another agent’s test environment remain unchanged.

## Parallel ownership

| Owner | Scope | Integration boundary |
| --- | --- | --- |
| Browser agent | Two matching lookup failures trigger vision; governed pinned Playwright CLI workflows; safe terminal-run tab retention | Sidecar browser modules; root registers tools and pins knobs |
| Operator agent | Per-day/bot/model cost dashboard; SOUL, approval rules and existing workspace egress controls | Cost API and Web screens; root shares types/client/navigation |
| Knowledge agent | Immutable knowledge history, pagination and orphan cleanup; attributed memory suggestion review; SOUL versioning/session invalidation | Knowledge/memory stores and routes; root lifecycle wiring |
| Integrator | node-pty interactive terminal; per-workspace sidecar cap and memory observations; contracts, integration and handoff | Shared configuration and lifecycle |

## Completion boundaries

All code stays in one isolated integration worktree with non-overlapping ownership. T0/T1 use injected fakes; no real model, shared image rebuild, deployment, or running service mutation is part of development checks. Changes to browser behavior remain an opt-in versioned strategy until paired evaluation. A passing development check does not establish milestone acceptance.

The user confirmed this batch retains public HTTP/HTTPS support. Private network services and database/TCP protocols belong to M3. Workspace sizing is observable and capped here; the numerical safe capacity needs a separate deployed workload measurement. Existing B1–B5 real-model, isolation, overnight approval and long-duration acceptance are handed to the testing agent, not silently marked complete.

## Bounded verification

Run type checks, focused tests for new invariants and affected UI behavior, then build the Web app. Native PTY, pinned CLI execution, real cgroup observations, tab retention and model strategy acceptance receive explicit isolated-environment test instructions. Stop after the planned development checks pass; investigate new failures without repeating unrelated evaluation campaigns.
