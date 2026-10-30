# Chat reading and delivered output

The 2026-10-21 review found two presentation failures in an actual multi-bot conversation:
long handoffs and the latest answer had almost the same visual weight, and scalar task results
looked like a long dump of implementation field names. This change affects presentation only.
It creates no model calls, changes no routing, and never rewrites the transcript or delivered data.

The owner's 2026-10-22 follow-up adds the Use/Tune history projection described in
[Everyday chat state and navigation](../../../docs/design/use-view-state-and-navigation-2026-10-22.md).
That projection moves historical failures and system process records to Tune; the message-folding
rules below continue to apply to the content visible in each view.

## Source review

Read the source, not just the screenshots, on 2026-10-21:

| Reference | Observed pattern | Application here |
| --- | --- | --- |
| [LobeHub ProcessFold](https://github.com/lobehub/lobehub/blob/main/src/features/Conversation/Messages/AssistantGroup/components/ProcessFold.tsx) | A completed turn's process has its own disclosure; the final answer is separate. Its default process state is collapsed. | Separate reading priority from diagnostic detail. Do not infer finality from a bot's name or its prose. |
| [LibreChat ToolCallGroup](https://github.com/LibreChat-AI/LibreChat/blob/main/client/src/components/Chat/Messages/Content/ToolCallGroup.tsx) | Completed tool groups can collapse, user overrides survive, and pending decisions need special visibility. | A reading toggle must not hide an approval or submit the composer's draft. Preserve explicit expansion on incoming events. |
| [Grok App TimelinePhaseBlock](https://github.com/RongleCat/grok-app/blob/main/src/components/lobe-chat/TimelinePhaseBlock.tsx) and [follow hook](https://github.com/RongleCat/grok-app/blob/main/src/hooks/useStickToBottom.ts) | Activity phases and their disclosure are distinct from answer content; following is released for intentional reading. | Release bottom-follow before a disclosure resizes. Keep the existing return-to-latest control. |
| [Grok Clone messages](https://github.com/M1n9X/grok-clone/blob/main/src/components/chat-messages.tsx) | Human bubbles, thinking state and answer Markdown are separate; automatic following depends on distance from the bottom. Answer content itself is rendered in full. | A Grok-like appearance alone does not provide multi-bot handoff structure or default long-answer folding. |

These are reference patterns, not copied components or dependencies. The reviewed file blobs
are recorded in the local review material; upstream main branches can change.

## Message rules

- Every bot message has a visible author and its own card, including consecutive replies from
  the same author. Human and system messages retain their distinct treatment.
- The last non-system message receives a Latest reply badge only if it is a bot reply. A new
  human question removes that badge from the earlier answer. It does not mean final, correct,
  accepted, or the answer to a later question.
- To labels use actual `mentions` metadata, not name extraction from the prose. They identify
  addressing intent, not proof that the target ran. Existing approval and outcome cards remain
  separate and are never folded by this feature.
- Completed bot text over 360 Unicode codepoints or eight source lines is eligible for folding.
  Historical replies initially show at most 240 codepoints and six source lines. A reasonably
  sized latest reply (at most 900 codepoints and 20 source lines) initially stays open. Larger
  latest replies show up to 640 codepoints and 12 source lines. The preview is labelled Excerpt,
  not an AI summary; it is a literal beginning of the original message.
- An eligible reply folds only when its excerpt hides more than a fifth of it (owner, 2026-10-22;
  `FOLD_MIN_HIDDEN`). The rendered heights decide: before paint the reply is laid out in full,
  then as the excerpt, and folding is offered only when the excerpt is under 80 percent of the full
  height, so a link target, table or code fence that counts many characters but little height
  does not fold. Without layout (jsdom, a hidden pane) the text decides: more than a fifth of the
  characters or of the lines hidden. A reply that is not worth folding shows in full with no
  disclosure. Measurement happens once per body; resizing does not refold.
- Initial reading priority and manual expansion remain with that message while mounted, so
  another reply cannot unexpectedly fold it. Reloading reapplies defaults. Deep links reveal
  the addressed message; long live streamed previews remain live and unfolded.
- Expanding mounts the existing safe Markdown renderer; off-screen excerpt tails are not hidden
  tabbable links. Attachment cards remain outside the text disclosure. A button has native
  non-submit semantics, an accessible author-specific name, `aria-expanded` and `aria-controls`.
- Controls marked `data-chat-disclosure` release ChatViewport's follow mode before resizing.
  Pointer and native keyboard-generated clicks use the same capture path. Sending, stopping,
  approvals, thread membership, read receipts and routing keep their existing contracts.

## Task output

Scalar fields use a compact responsive grid; limitations and compound values span the row.
Schema `title` and `description` supply readable labels and explanations when present. A missing
title falls back to the original key with underscores separated. The UI does not translate an
arbitrary business field, guess a unit, append a percent sign, or round a delivered number.
Bot-supplied metadata and values remain escaped text. The review note asks the person to check
results, units and limitations against the file before acceptance.

The synthetic order fixture omitted schema titles, which explains its raw English labels.
Meaningful field titles and units belong in the task's declared output format; a generic renderer
must not silently impose order-report semantics on unrelated tasks.

## Verification

Regression checks cover default excerpts, a readable latest answer, deep-link expansion,
retained reading choices on SSE, hidden tail-link focusability, unchanged unsent drafts and no
POST on disclosure; ChatViewport checks scroll position and explicit return-to-latest. Output
checks cover schema labels/descriptions, exact numbers, escaped text and visible limitations.
Visual verification uses the retained real-model conversation and accepted task in the isolated
preview at 1074px and 1280px desktop widths. Expansion, keyboard operation with an unsent draft,
return-to-latest and responsive output cards were checked. Mobile and dark mode were not
separately browser-verified. Exact results are in
[`chat-reading-results-2026-10-21.md`](../../../docs/design/chat-reading-results-2026-10-21.md).

## Mobile geometry regression (2026-10-28)

Phone chat headers reserve space for a More chat actions button; the title truncates and
retains its full title text. Members and browser controls remain available in that disclosure.
Escape closes it and restores focus, and a pointer outside dismisses it. Desktop actions stay
inline. Consecutive addressed replies explicitly span the message grid instead of entering the
hidden avatar column. Phone message metadata wraps independently of the body; excerpt character
counts are hidden on phones while the accessible expand/collapse control remains available.

`npm run check:chat-layout -w packages/web` runs the rendered demo at 360, 390, 430, 760 and
1280 CSS pixels, stressing a long bilingual group title and a consecutive multi-recipient reply.
It checks viewport containment, header overflow, message-header width/height, and phone-menu
keyboard dismissal. It is part of `check:layout`, hence the existing CI layout gate.
The test failed on v0.8.0 at every width (28px-wide, 833.5px-high metadata with the stress text)
before the CSS correction. Screenshots are written to `/tmp/deskmates-chat-layout`.
This is a local regression fixture, not a claim of deployed stable verification.

## Conversation reading groups

The reference-led reading pass groups a compact author header, a softly surfaced reply and
its delivered attachments. Transcript width is bounded at 800px on wide displays; phone replies
use the available width. Consecutive messages stay closer together while preserving explicit
addressing. The reply surface uses the existing theme surface token rather than status colors;
a reply background does not imply success, approval or a particular bot capability.
Long-message expansion remains explicit and keyboard accessible; repeated character counts are
removed from the visual hierarchy at every width. File metadata and preview/download actions
remain outside the reply bubble. No attachment is invented from a mentioned path, and no model
text, routing or approval policy changes.
