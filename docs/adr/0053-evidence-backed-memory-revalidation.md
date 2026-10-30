# ADR-0053: Evidence-backed memory revalidation

Date: 2026-10-21
Status: Accepted (owner approved the evidence rule on 2026-10-21).
Builds on: ADR-0011 A25 to A34; ADR-0052.

## Context

The configured-model lifecycle check of 2026-10-21 found an aged synthetic quota note renewed
as `still_true` because unrelated recent activity did not contradict it. The existing prompt
explicitly permits consistency with no sign of change. Thus the stored confirmation time can
mean "no contradiction noticed", although the product presents it as a current recheck.
The mechanical job, version and daily-limit checks passed; that does not verify the fact.
The private lab material is titled "Goal-first real-model lifecycle validation", dated
2026-10-21. This is one functional counterexample, not an accuracy estimate.

## Decision

1. **Renew only with supplied supporting evidence.** A `still_true` answer must cite a bounded,
   exact quote from a recent shared message supplied to this job, newer than both the note's
   effective time and its last confirmation, and no later than the snapshot time. The note itself, its
   topic label and the absence of contrary activity are not evidence. Private chats remain
   excluded. A citation establishes that the evidence exists, not that the model read it well.
2. **Preserve uncertainty.** Missing, irrelevant or ambiguous support is `unclear`; no note
   version or confirmation time changes. `possibly_stale` retains the existing human-review
   queue. Ordinary uncertainty does not create a new per-note approval request.
3. **Freeze the evidence.** Before inference, store the bounded, redacted activity references
   and content hashes with the job's input versions and a policy version. Validate citations
   against that exact input, never a newly reconstructed transcript after the model returns.
   A quote absent from the supplied item, a foreign item or a changed note cannot renew it.
4. **Preserve the existing boundaries.** The Gateway performs deterministic validation only;
   the sidecar runs the one tool-free model turn. Trust, scopes, TTL policy, exclusion of private
   chats, daily quotas and the per-version 24-hour no-retry window remain. Human confirmation
   and undo remain available through their existing APIs. No memory becomes a rule.
5. **Measure the policy separately.** Version and freeze the new prompt and reply protocol.
   Functional acceptance requires supported, unsupported, contradictory and malicious-citation
   fixtures. Claims about quality require paired evaluation against the existing policy;
   the lifecycle run alone cannot establish improvement.

## Verification

Implementation and functional validation are tracked in the lifecycle report; paired quality
evaluation remains pending. Historical unsupported confirmations are preserved, not rewritten.

| Decision | Means | Test | Metric |
| --- | --- | --- | --- |
| 1 | Renewal has an exact supplied citation; absence of contradiction is insufficient | contracts reply-parser and gateway `memory/recheck.test.ts`; configured-model unrelated-activity fixture | unsupported renewals = 0 on deterministic fixtures; citation coverage = 1 |
| 2 | Unclear does not refresh a note or create approval traffic | gateway `memory/recheck.test.ts`; existing maintenance route tests | false confirmations; human actions per note |
| 3 | Completion reads the frozen evidence, rejecting foreign, altered and invented quotes | gateway recheck restart/concurrency tests; sidecar `model-job.test.ts` | accepted invented citations = 0 on fixtures |
| 4 | No trust/policy escalation, private text, duplicate daily submission or Gateway inference | existing memory, privacy and architecture tests extended for policy version 2 | rule changes = 0; duplicate entry/version attempts = 0 per 24 hours |
| 5 | Attribution and a paired comparison exist before a quality claim | frozen lab manifest and paired evaluation report | false-confirm/false-stale rates, recall, tokens and confidence intervals |

## Compatibility

This decision supersedes ADR-0011's consistency-without-contradiction criterion for automatic
confirmation. New jobs record policy version 2 and their redacted, bounded evidence snapshot in
`runs.config_json`. Legacy queued jobs without that snapshot cannot renew notes; an unsupported
`still_true` is recorded as `unclear`. Existing historical verdicts remain unchanged. Shared
message text is eligible evidence; task titles/status and system notices remain context only.
Completion checks exact source identity, SHA-256, quote and time. Semantic relevance is still
model judgment, so an exact but irrelevant quote is a retained model-quality risk.

Amendment 1 (2026-10-21): the model reads each source through the sidecar's markup-escaped
prompt, so a quote copied as shown (`&amp;` for `&`) failed the exact match and withheld a
renewal the evidence supported. The check now accepts a quote that is a verbatim substring of
the frozen source in either its original or its escaped form, after folding whitespace on both
sides; the quote itself is never decoded, so a half-decoded mix matches nothing. The parser's
quote bound rose from 500 to 600 characters so a whole truncated source (500 characters plus
the mark) is quotable. Neither change admits a quote that is not in the frozen source
(`memory/recheck-evidence.test.ts`).

