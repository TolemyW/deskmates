# ADR-0056: Literal mentions do not route, and a bot broadcast is explicit

Date: 2026-10-24
Status: Accepted (owner requested the diagnostic's accidental-broadcast fix).
Amends: ADR-0005 decisions 3, 4 and 50; ADR-0024 mention diagnostics.

## Context

A specialist's diagnostic report discussed mention syntax and included a literal
broadcast token in its prose. That report woke all four other group members.
Routing cannot infer whether arbitrary prose is an instruction or a quotation.
Reports need deterministic literal syntax, and a bot's group broadcast needs
an explicit address rather than a matching word anywhere in a report.

## Decision

1. **Code and escaped mentions are literal.** Fenced code (backticks or tildes),
   matched inline backtick spans, Markdown quote lines, and an at-sign escaped
   by an odd number of backslashes do not address bots or produce unknown-name
   or spaced-name diagnostics. Original transcript text is retained unchanged.
   An unclosed fence remains literal through the end of the message; an
   unmatched inline delimiter is ordinary prose. A closing fence must use the
   same delimiter and at least the opening length.
2. **A bot's broadcast belongs in its leading address list.** In a bot-authored
   message, `@everyone` broadcasts only before the first non-address prose;
   the prefix may contain other `@names`, whitespace and address separators
   (commas, colons or semicolons). A broadcast mentioned later in a report is
   literal for routing. Explicit individual mentions retain their existing
   anywhere-in-prose behavior outside the literal regions of decision 1.
   Human broadcast placement is unchanged outside literal regions.
3. **All mention consumers agree.** The strict and spaced parsers, unknown-name
   diagnostics and private-chat handoff validation use the same literal-region
   rules. A human message with only literal mentions still follows ordinary
   unaddressed routing; a bot report with none addresses nobody. Under `owner-v1`
   and `round-v1` it wakes nobody; the opt-in legacy `walk-v1` keeps its ordinary
   serial walk. Leading bot broadcasts keep existing caps and author exclusion.
4. **No natural-language intent classifier is introduced.** A plain individual
   mention in a sentence containing a negation still routes. Authors use code
   or escaping for examples. This is deterministic routing syntax, not bot
   access control or a model-strategy quality claim. No historical message or
   run is rewritten, and no paired reliability improvement is claimed.

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | Code, quote lines, escaped at-signs and incomplete fences are literal; matched/unmatched inline spans and fence lengths are distinguished | T0 `contracts/src/literal-mentions.test.ts` | Unexpected wakes from literal examples (zero in fixtures) |
| 2 | The diagnostic report's prose broadcast creates no fan-out; a leading broadcast still wakes every other member; human placement and direct handoffs remain supported | T0 `literal-mentions.test.ts`; T1 `gateway/src/threads/literal-mentions.test.ts` | Bot runs per report versus explicit broadcast |
| 3 | Diagnostics, private handoffs, and strict/spaced group routing agree without altering transcript bytes | T0 and T1 literal-mention suites | False handoff errors from examples (zero in fixtures) |
| 4 | Ordinary prose mentions still route, historical rows stay untouched, and no model is invoked by parsing | T0 and T1 literal-mention suites | None; deterministic contract checks only |
