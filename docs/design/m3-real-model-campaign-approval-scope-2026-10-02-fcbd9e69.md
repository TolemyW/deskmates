# Proposed real-model campaign scope — not executed

Historical candidate/launch binding: the later
[latest-candidate preparation](m3-latest-model-campaign-preparation-2026-10-03.md)
retains the scope tables below but binds the completed 42bab952 candidate,
its current compiled runtime and repaired accounting. The old launch commands
below are preserved as a historical proposal, not current dispatch instructions.
Neither proposal has been executed or authorized.

This is the concrete scope awaiting direct human approval after automatic
approval rejected the combined launch. It does not authorize execution.
Candidate manifest:
`fcbd9e6993ce8f4136ace2606f666f2cb113c9b3b37acba46c003a025b67642f`;
archive:
`3d29ab69fa90b99f04e0cba15c241e6b376edd78480f72c0d2c9f61786f20228`.
Use the four final image IDs in the candidate's `images.json` and its frozen
931-file source. Deterministic gates passed: 2438 T0/T1, eight supplemental,
86 T2 with zero failures and one existing model-call skip. Final-image-bound
product/data preflight passed. All 181 journaled resource identities were
absent on final inspection; some removal commands returned nonzero because
the test's own teardown had already removed those identities.

## Eighteen existing T3 suites

Execute each selected file once, serially, with maxWorkers=1,
M2_REPETITIONS=1, owner-v1 routing and explicit-v1 snapshots. The matrix
contains **37 registered assertions**, not eighteen or 37 model calls.
Some assertions inspect earlier results without invoking a model; others
contain multiple independent tasks, corpus items, or delegated bot runs.
The counts below come from the frozen test source and loop expansions.

`maxTurns` and deadline are per physical sidecar attempt, not a whole-group
token budget. Deadlines are the Gateway's configured values; test/oracle
waits and Vitest limits can end a case earlier. Test limits below omit
separately bounded setup/teardown hooks. Each suite's outer runner stage is
capped at 3600 seconds, with termination then a maximum 30-second kill grace.
The proposed overall model runner hard watchdog is 14400 seconds (4 hours).
At that limit, unfinished suites/modes remain partial or uninvoked; there is
no automatic continuation, repeat campaign, or replacement task. The four-hour
ceiling can end the complete planned matrix before all files run.
The earlier 4-hour deterministic watchdog does not authorize or run models.

| Frozen `acceptance/` file | Assertions | maxTurns / attempt | Deadline / attempt (s) | Assertion timeout (s) | Tasks and multiple-attempt boundaries |
| --- | ---: | ---: | ---: | --- | --- |
| m0-login-form.acceptance.test.ts | 2 | 50 | 900 | 660; default 5 for ledger check | One S01 task; second assertion reads its ledger. |
| m0-model-swap.acceptance.test.ts | 3 | 50 | 900 | 1500 each arm; default 5 for comparison | Two S01 tasks on DEFAULT_MODEL and CHEAP_MODEL; entire suite blocked before calls unless nominated models differ. |
| m1-approvals.acceptance.test.ts | 5 | 50 | 900 | 660, 1200, 1200, 1200, 2400 | Six task posts: login, allow, deny, park, Always, by-rule. Park explicitly resumes the same logical run; allow/deny/Always can also cross the short-wait boundary. No replacement task for a failed attempt. |
| m1-cron.acceptance.test.ts | 2 | 50 | 900 | 360; 60 for file check | Timer remains active during the case. At least two successful minute firings expected; extra firings can occur before teardown, so not exactly two model calls. |
| m1-takeover.acceptance.test.ts | 2 | 50 | 900 | 660; 1800 | Login plus checkout. Human verification occurs in the shared browser while checkout stays running; test does not repost checkout. |
| m2-billing-chief.acceptance.test.ts | 1 | 30 | 300 | 720 | One human task delegates to two experts and wakes a chief summary; multiple SDK runs. Thread turn budget 8. |
| m2-bot-message-injection.acceptance.test.ts | 1 | 8 | 180 | 1200 | Four frozen corpus items, one explicitly launched receiver per item. Synthetic sender run rows are not model-driven. Unexpected approvals remain evidence, not an authorized resume loop. |
| m2-browser.acceptance.test.ts | 1 | 6 | 180 | 240 | One repetition contains two concurrent metric-reader tasks. |
| m2-chief.acceptance.test.ts | 1 | 8 | 180 | 480 | Chief, two experts and chief result wake; model-dependent relay count. |
| m2-group-foundation.acceptance.test.ts | 4 | 8 | 180 | 480 each | One repetition of chief delegation, ordered owner delivery, two parallel peers and bus handoff. Multiple SDK runs; expected normal minimums 4/1/2/3 respectively, not fixed HTTP-call counts. |
| m2-group.acceptance.test.ts | 1 | 8 | 180 | 720 | Parallel mentions, unaddressed owner routing and joined-member history tasks; multiple runs. |
| m2-knowledge.acceptance.test.ts | 1 | 8 | 180 | 420 | Writer then reader task, separated by operator knowledge review. |
| m2-takeover.acceptance.test.ts | 1 | 50 | 900 | 1440 | Two concurrent bot tasks plus human MFA takeover; test waits up to 480 s per run and does not repost either task. |
| m2-ticket-workflows.acceptance.test.ts | 2 | 35 | 300 | 1080 each | X02 and X03 each execute solo A, solo B, then paired A+B: four task posts per scenario, eight total. These existing arms are prescribed comparisons, not failure retries. |
| m3-delegation-outcome.acceptance.test.ts | 2 | 8 | 120 | 480 each | Silent-expert and failed-expert scenarios, each involving chief/expert/outcome wakes. Failed expert uses deliberate unavailable-model identity; refusal attempts must be counted. |
| m3-group-owner.acceptance.test.ts | 4 | 8 | 180 | 660 each | Combine, follow-up, single and relay questions. Multiple member offers/delegations; unexpected parked actions stop/settle as evidence. |
| m3-group-workspace.acceptance.test.ts | 1 | 14 | 300 | 900 | One shared-browser brief request routes/delegates among three members. Unexpected parked actions are retained. |
| m3-domains.acceptance.test.ts | 3 | 20 | 900 | 1200 each | One reserved human task each for data, generated app test and quant. Product artifact is replayed by the host on normal/mutant/changed normal targets without a new model task. No retry or replacement task. |

Normal same-logical-run approval decisions already implemented by the frozen
approval suite are part of that suite. New approval watchers, Always rules,
turn-limit continuations, replacement task messages, or fresh logical runs
after a blocker are not added by this proposed campaign. Existing group
routing, relay caps and per-thread budgets remain unchanged. A file executes
once even if it fails; all failures/partial runs are retained.

There is **no verified hard total of upstream API calls** for this T3 matrix.
An SDK query can produce multiple turn requests, count-token/title calls,
transport retries and resumed physical attempts; bot messages and cron can
create additional run rows. maxTurns bounds turns per physical attempt and
does not equate to billed request count, total tokens, output tokens, or
model-cost dollars. The frozen suites do not add a campaign-wide forwarding
request cap or explicit per-request output-token ceiling. No output-token
ceiling or total-cost figure should be invented for approval.

## Two separately inventoried context observations

These are a measurement tail after the eighteen-suite matrix ends, not T3
assertions or a memory strategy campaign. Candidate deterministic gates must
have passed. Source manifest:
`3fb2b635ee4ec9abdb15c91f4fa273b31d51756ea15ab112b64bbed3fd4c936d`;
directory:
`/home/owner/agent_workspace/deskmates-reusable-context-probes-20261002-3fb2b635`.
Bind its host SDK/runtime to this candidate, reserve each mode once, use
fresh report directories and no tools. No raw prompts, thinking or secrets
are saved by the recording proxy. No script-level retries.

| Mode | Invocation and upstream bounds | Input scale | Output bound | Deadlines |
| --- | --- | --- | --- | --- |
| sdk-resume | One mode invocation; at most two SDK physical queries (fresh A, same-session resume B), one turn each. First failure prevents second. Recording proxy forwards at most 20 total requests, including auxiliary/count-token requests and SDK transport retries. Requests beyond 20 receive local 429 and are not forwarded. | Small synthetic prompt/system markers; SDK-added context means exact tokens are unknown. Proxy rejects any raw request body over 3,000,000 bytes before forwarding. | No explicit output-token limit in this frozen SDK probe. Proxy caps each upstream response at 4,000,000 bytes; request prompt asks for OK only, which is not a hard token cap. | 120 s per query and per forwarded request; outer mode stage 360 s plus up to 30 s termination grace. |
| window-cache | One mode invocation; at most seven direct `/v1/messages` requests, no auxiliary SDK calls. First failure/timeout ends ramp; duplicated small input is a predeclared cache observation. | Synthetic body sizes 4096 twice, 65536, 262144, 524288, 1048576, 2097152 characters, plus 70 characters of fixed user prefix/suffix and a short system note. Maximum actual user string 2,097,222 characters. Character counts are not token counts. | `max_tokens:16` each, maximum nominal 112 generated tokens across seven successful requests. | 120 s per request; outer mode stage 900 s plus up to 30 s termination grace. |

Only this two-mode tail has a known upstream forwarding upper bound of
20 + 7 = 27 requests; it does not bound the T3 matrix. Accepted input is a
lower bound on supported context, not a maximum or an adopted setting.
Missing token fields remain null/unknown, and cumulative SDK resume usage is
not summed as independent usage. No verified model price table is supplied.

## Explicitly excluded SDK-shape call and live prerequisites

The T2 skipped assertion is
`real SDK call shape (maxTurns: 1, cheapest model) calls the PreToolUse hook
and canUseTool with the shapes the sidecar relies on`.
The title is stale: the frozen implementation actually sets `maxTurns:2`,
reads DEFAULT_MODEL, and has no query AbortController/deadline; its assertion
uses the default Vitest 5000 ms timeout. There is no cheapest-model selection
in that source. A future separately approved wrapper should cap its owned
process group at 120 seconds, reap it and preserve partial/unknown usage,
without silently changing source thresholds.
It is **not** one of the eighteen T3 files, 37 assertions, or two context
measurements, and is not included in the proposed execution. If the owner
adds it to approval scope, reserve one additional standalone invocation,
bind its source/runtime, declare its own request/deadline boundaries and
retain actual usage; do not silently interpret it as covered by T3.

Live WhatsApp remains blocked: the owner has a WABA account, but scoped
test-number/account configuration is not ready. Long mission, visual model,
paired model A/B, browser interference, and memory strategy campaigns remain
outside this invocation. Their absence does not count as passing M3.

## Credentials, accounting and isolation

The proposed model bootstrap is the previously agreed same-user memory-only
Node parseEnv path selecting MODEL_BASE_URL, MODEL_AUTH_TOKEN, DEFAULT_MODEL
and CHEAP_MODEL from the exact owner-approved mode-0600 test configuration.
Never source/eval/copy that file; never put values in argv/logs/receipts.
Use only the existing internal endpoint and nominated models. Upstream
receives synthetic controlled task prompts, golden-site fixtures and their
tool output; no stable production data/credentials are used.

Preserve source/image bindings, run IDs, observed physical attempt IDs,
per-model input/output/cache-read/cache-create counts and partial outcomes.
Separate fake ledgers from real calls; missing usage is unknown. Stage/unit
caps are declared above. Hold the Testbox heavy-test lock and clean only
exact journaled resources. No deployment, commit, tag, merge, prefix cleanup,
image prune, or change to stable services is part of this proposal.

At publication, real model calls and model-configuration reads remain zero.
The rejected combined runner has not been launched or bypassed.

## Prepared model-only runner and exact proposed launch

Prepared local runner:
`spikes/latest-code-validation-20261002-qa/model-only-runner.py`.
SHA256:
`e269606ded95dc17c1484c1a0d247cdae7c0b664f0628ee428a64300a7b79a2b`.
Syntax compilation, hard-bound scope checks and a local no-model process
deadline/reaping check passed; receipt:
`spikes/latest-code-validation-20261002-qa/work-evidence/model-only-preparation/self-check.json`.
No model environment was read and the runner was not executed or transferred.

It verifies completed candidate gate reports, source/archive hashes and four
exact final image IDs before loading model configuration. It creates a fresh
owned model directory and reconstructs the immutable business snapshot,
reusing hashed compiled files and Linux dependencies from the tested
candidate. Only the disclosed ledger-preservation test-support overlay is
applied; original hashes are checked before every suite. The independent
context source remains separately inventoried. SDK-shape has no enabling
flag and is always excluded in this prepared runner.

Every twenty seconds while a T3 stage is live, owned temporary ledgers are
snapshotted and usage accounting updated. Run IDs are deduplicated between
live/final backups. Missing usage and interrupted coverage remain unknown.
No request-count claim is inferred from these ledger snapshots. Mode probes
retain their own request/usage receipts. Cleanup uses only exact journaled
IDs; interrupted cleanup must be recovered from those journals.

After explicit human approval, the proposed transfer and launch are:

```sh
scp spikes/latest-code-validation-20261002-qa/model-only-runner.py \
  testbox:/home/owner/agent_workspace/deskmates-reusable-m3-candidate-20261002-fcbd9e69/model-only-runner.py
ssh testbox 'sha256sum /home/owner/agent_workspace/deskmates-reusable-m3-candidate-20261002-fcbd9e69/model-only-runner.py'
```

Compare that printed hash to the exact prepared hash before dispatch. Then:

```sh
ssh testbox 'systemd-run --user \
  --unit=deskmates-m3-model-only-20261002-fcbd9e69-01 \
  --property=RuntimeMaxSec=14370 \
  --property=TimeoutStopSec=30 \
  --property=KillMode=control-group \
  python3 /home/owner/agent_workspace/deskmates-reusable-m3-candidate-20261002-fcbd9e69/model-only-runner.py \
  /home/owner/agent_workspace/deskmates-reusable-m3-model-fcbd9e69-20261002-01'
```

The script independently enforces 14370 seconds through a monotonic deadline,
per-stage remaining-budget checks and an alarm. A local sleeping child was
terminated/reaped after 0.363 s using a scaled budget, and the next stage did
not start. 14370 seconds active time plus at most 30 seconds termination grace gives a
four-hour outer ceiling. No stage is automatically resumed after that
ceiling. Standard stage logs and reports live under the new model directory;
service stdout goes to the owned unit journal. The command contains no model
values, credentials or authorization bypass. The same-user child bootstrap
uses only the exact previously scoped test configuration at
`/home/owner/agent_workspace/deskmates-m2-chief-20260928/model.env`.
This prepared command is a review artifact, not approval or an invocation.
