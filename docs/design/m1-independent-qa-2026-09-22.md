# Independent M1 QA — 2026-09-22

## Scope and isolation

Tested commit: `5f2a4236e9cbc53175043bed88b1868d7c74c349`.
Branch: `codex/m1-independent-qa-20260922`.
Worktree: `.claude/worktrees/codex-m1-independent-qa-20260922`.

Another agent was running the main checkout's build/container/model acceptance
pipeline. This review used a fixed commit, separate node_modules and npm cache,
fake SDK/provider, in-memory databases, and a single test worker.
No existing service was started, stopped, or reconfigured. No Docker command,
image build, real model call, application database edit, or port 5173/8080 operation
was performed. The standard integration tests used independently allocated
localhost ports. New price tests used in-process Fastify injection.

Only QA fixtures and this report were added in the independent worktree.
No production source was changed or merged into the main checkout.

## Verification

| Check | Result |
| --- | --- |
| `npm test -- --maxWorkers=1` | 59 files, 849 tests passed; 19.06 seconds |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; 243 files checked |
| `npm run typecheck -w packages/web` | Passed |
| `npm run build -w packages/web` | Passed |
| `npx tsc --noEmit -p evals/tsconfig.json` | Passed |
| `npx tsc --noEmit -p spikes/m1-independent-qa/tsconfig.json` | Passed |
| Independent boundary suite | 13 tests: 6 passed, 7 failed as defect reproductions |

The first standard-test invocation could not bind localhost under the default
sandbox (`listen EPERM`); only that invocation was stopped, and the complete suite
was rerun with network permission. The successful result above is the rerun.
This environmental failure is not counted as a product defect.

Passing supplementary controls cover takeover-only replay, simple deferred/approved
resume, already-redacted headers, atomic price-batch rejection, normalization of
equivalent effective timestamps, and price-state isolation across Gateway instances.

## Reproduced findings

All findings below are P2. They concern replay/export correctness and the export
guard. They do not establish a live approval bypass or an actual credential leak
in the deployment.

### QA-01: A blocked navigation shifts the recorded browser-lock answers

Source: `evals/replay/replay-run.ts:183` (`recordedBrowserLocks`).

Reproduction: record an out-of-allowlist navigation followed by a browser snapshot
while a human holds the browser. The real hook denies both calls. Replay of that
same trace under unchanged code allows the snapshot and reports two differences:
`hookDecision: deny → allow` and `browserLock: blocked_by_human → granted`.

Cause: the replay queues a lock answer for every browser call. Egress-denied
navigation returns before acquiring the lock, so its answer is consumed by the
following call. The takeover-only control passes.

Impact: replay can report a framework behavior regression where there is none.
This is a replay simulation failure; the original recorded hook correctly denies
the action.

Suggested fix: associate lock answers with calls that actually request acquisition,
or record/replay acquisition events explicitly. Preserve the sequence when egress
or another earlier guard rejects a call.

### QA-02: Replay loses an approved retry after a stale browser reference

Sources: `evals/replay/replay-run.ts:152` (`recordedApprovals`),
`:203` (`requestFromTrace`), and `:314` (single `runOnce`).

Reproduction: navigate to an allowed checkout, defer a Submit click, record the
human's approval, and resume the same SDK session. The resumed click returns a
stale-reference error; a fresh snapshot and an equivalent Submit click succeed
using the existing approval. The real sidecar fixture completes successfully and
records `consumedBy: retry`. Replay reports the later click as
`hookDecision: allow → deny`.

The fixture includes the Gateway broker's `decided` event before resumption.
A simpler deferred/approved command without the stale-reference retry replays
successfully and is retained as a control.

Cause: replay flattens a multi-attempt run into one fresh request. The later retry
depends on resume state and does not create a second approval request in the
recorded run. The replay asks again, runs out of recorded approval answers, and
denies the click.

Impact: the replay gate cannot currently validate this existing approval-resume
behavior reliably. This is not a reproduction of a live approval API 409.

Suggested fix: reconstruct attempt boundaries and the approval trigger/session
state, or explicitly mark unsupported traces rather than reporting a decision
regression. Add this combined stale-reference/resume case to replay coverage.

### QA-03: Exported model provenance can be wrong

Source: `evals/replay/trace.ts:269`; producer:
`packages/gateway/src/context.ts:75`.

Two failing checks:

1. The Gateway records the default model under `config.defaultModel`. A bot that
   inherits this setting exports as `replay-model` because the exporter reads
   `config.model` instead.
2. If a trace source supplies an explicit historical `config.model`, the bot's
   current model still takes precedence and overwrites it. This second case tests
   the exporter's advertised fallback field, not a claim that the current Gateway
   already snapshots effective bot overrides under that field.

Impact: a saved trace can be attributed to the wrong model, weakening later
model comparisons. This test does not show incorrect token billing; usage rows
retain their own model field.

Suggested fix: persist the effective model per run, prefer immutable run metadata,
and recognize the existing `defaultModel` key. Do not silently treat the bot's
current model as the historical one.

### QA-04: Export guard misses structured credential headers

Source: `evals/replay/trace.ts:309` and `:362`.

Reproduction: pass a trace containing a log payload with either
`headers.cookie` or `headers["x-api-key"]` set to a synthetic non-redacted
credential marker. `assertNoSecrets` accepts both.

Cause: the header detector expects the header name immediately followed by a
colon/equal sign. In serialized JSON, a quote intervenes between the key and colon.
The marker has neither a Bearer prefix nor an sk- prefix, so the other regexes
do not rescue this case.

Impact: the export guard fails as a second defense if upstream redaction misses
a structured header. These tests inject synthetic trace data directly; they do
not establish that the deployed ledger currently contains such values.

Suggested fix: inspect structured sensitive fields recursively and independently
test both object fields and credentials embedded in text.

### QA-05: Export guard repeats the credential in its rejection error

Sources: `evals/replay/trace.ts:335` and `:347`;
CLI error output: `evals/replay.ts:145`.

Reproduction: a synthetic Bearer credential correctly triggers `TraceSecretError`,
but the full marker appears in `error.message`. The CLI prints that error to
stderr. Truncating matches to 60 characters still exposes the complete credential
when it is shorter than that, and exposes a prefix otherwise.

Impact: when the guard detects an upstream redaction failure, its error path can
copy the sensitive value into terminal/CI logs.

Suggested fix: report the run ID, field path, and finding category without the
matched value. Keep any diagnostic sample redacted.

## Reproduction and limitations

Run from this worktree:

```sh
npx tsc --noEmit -p spikes/m1-independent-qa/tsconfig.json
npx vitest run --config spikes/m1-independent-qa/vitest.config.ts --reporter=verbose
```

The supplementary suite deliberately exits 1 at the tested baseline.
The seven failing assertions cover the five findings above: one each for QA-01
and QA-02, two for QA-03, two for QA-04, and one for QA-05.
Fixtures and raw local output are under `spikes/m1-independent-qa/`;
`work-results/` is ignored by Git. Standard tests exclude `spikes/`.

This is complementary QA, not an M1 acceptance sign-off. It does not repeat T2
Docker tests, T3 real-model acceptance, T4 behavior evaluations, or manual browser
checks of the live UI. The other agent's final results have not been independently
verified here. Findings apply to the pinned commit, not to later changes it may
make in the main checkout.
