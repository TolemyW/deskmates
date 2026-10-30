# Chat reading and output review results

Date: 2026-10-21
Scope: owner screenshots of raw task fields and hard-to-distinguish long group replies.
Verdict: the presentation changes passed the Web/UI checks and retained-data browser checks.
This is not a model-quality evaluation, release acceptance, or a stable deployment.

## Findings and changes

The first screenshot was structured data from a revised synthetic task delivery: net orders
170, target 220, gap -50 and completion 77.27 percent. Its output format omitted human-readable
field titles. The generic renderer exposed the keys as four tall rows. It now uses compact
responsive cards, reads schema titles/descriptions when supplied, keeps warnings full-width,
and preserves exact values as inert text. It does not guess business labels or units.

The second screenshot was the earlier group trial at 180/200. Those historical messages are
not rewritten when a later formal task is revised. Equal-weight, uninterrupted bot text made
it difficult to see the reviewer-to-coordinator handoff and the latest answer.

Each bot reply now has its own card and persistent author. Actual addressing metadata supplies
To badges; the latest non-system bot reply has a Latest reply badge, which is not a finality or
correctness claim. Historical long text defaults to a literal excerpt. A reasonably sized latest
answer stays open; exceptionally long latest answers have a longer excerpt. Manual reading
state survives incoming messages, deep links reveal their target, live previews remain unfolded,
and approvals/outcomes/attachments stay outside this text-folding policy. Five locales cover
the controls. Exact thresholds and the source comparison are in
[the feature notes](../../packages/web/docs/chat-reading-and-output.md).

## Open-source comparison

Source review covered LobeHub's ProcessFold, LibreChat's ToolCallGroup and reasoning disclosure,
Grok App's TimelinePhaseBlock/follow hook, and a smaller Grok Clone's message renderer. The useful
shared pattern is distinct presentation for process, answer and decisions, with intentional
reading overriding auto-follow. A Grok-like theme alone does not supply a multi-bot handoff
model. This implementation uses those patterns without copying components or adding dependencies;
primary-source links are in the feature notes.

## Checks

- Focused chat/task/i18n/viewport and registry checks: 52 files, 563 tests passed in 20.73 seconds.
- Full Web: 236 files, 1,687 tests passed in 68.77 seconds.
- Independent UI package: 11 files, 27 tests passed.
- Repository typecheck, lint, documentation checks and the Web production build passed. The
  existing large-chunk build warning remains. The earlier source-layout failure was fixed by
  keeping CSS in each feature's canonical stylesheet; a missing test-only type import was fixed.
- These are the frontend follow-up checks. The earlier 8,272-test core-iteration result remains
  historical evidence and is not represented as another full-backend run for this UI change.

The retained real-model group showed analyst-to-editor and editor-to-assistant labels, folded
historical reports and a fully readable latest summary. Expanding the reviewer preserved
`scrollTop = 705.5` while content height changed from 1487 to 1625. The return-to-latest control
restored following. Native Enter on the disclosure retained an unsent fixture draft; no message
was sent, and the probe was cleared. The reproducible CUA check is under
`spikes/chat-reading-20261021/`. Its first replay conflated keyboard focus scrolling with
expansion; that strict failure is retained. The corrected replay establishes non-activating
keyboard focus before measuring Enter, retains the same one-pixel assertion, and passed with
`scrollTop = 602` before and after expansion. The product behavior was unchanged by this
measurement correction.

The accepted task retained its accepted state, revised values and publication link. Cards were
inspected in 1074px and 1280px desktop viewports; the 1074px page had no horizontal overflow.
Mobile and dark mode were not separately browser-verified. The private review material is titled
"Chat reading UI review, 2026-10-21" and contains original/final screenshots and gate logs.

The final static bundle has 28 inventoried assets, archive SHA-256
`6c3735b9dfc5d22350c4708797db861a10e37f786fbd9c316e6a639c126d1367`.
It replaced only the isolated preview's Web directory, retaining earlier assets and backups.
A read-only post-check found the same 61 logical runs, zero active runs and drain still on.
No new model campaign, data migration, Gateway change, merge, tag or stable upgrade occurred.
