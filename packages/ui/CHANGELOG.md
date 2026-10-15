# Changelog

## Unreleased

- Breaking: `BrandMark` renders the Deskmates icon as a 1:1 `<img>` of a cropped 256 px PNG
  in its own colors, no longer an inline `<svg>` with a 784:628 viewBox that followed
  `currentColor`; consumers styling `.brand-mark > svg` or relying on text color must
  update. The image is not draggable.
- Add a presentational `Pager`: a labelled navigation landmark with Previous/Next, a
  caller-formatted live range text and disabled boundaries; it owns no paging state.
- Add controlled `ResizeHandle` with pointer capture, keyboard sizing and bounds.
- Center secondary action menu glyphs without changing their native control styling.

- Add an owned `ActionMenu`: an icon-only trigger with an accessible name and a HeroUI
  menu for secondary row actions, with disabled and danger items and keyboard navigation.

## 0.1.0 — 2026-10-10

- Let `Avatar` show a supplied image (`src`) in its circle, returning to the name-based
  initials when the image is absent or fails to load; add a large `lg` size.

- Add semantic Table primitives with HeroUI surfaces, native cell controls, and contained horizontal scrolling.

- Add an owned, labelled Select with HeroUI popovers, keyboard navigation, disabled options
  and native form values; include a standalone studio example.


- Establish the private, independently built HeroUI-based Deskmates component package.
- Add owned buttons, button links, inputs, text areas, pills, cards and empty states.
- Add a standalone studio with themes, interaction examples and a workbench composition.
- Connect the operator application's shared primitives to the owned API.
- Preserve native HeroUI colors, rounded controls and surface shadows; token aliases only.
- Add labelled switches/checkboxes and native tabs, sliders, labels and spinners.
- Add circular username avatars with stable name-derived HeroUI soft colors and Unicode initials.
- Add the owner-supplied Deskmates logo as a shared, theme-aware brand mark.
- Add a multiline message composer with IME-safe Enter submission; simplify the
  Chat studio to a neutral conversation layout with expandable research details.
- Add shared workspace navigation, page headers, metric cards and consistent outline icons.
- Make ordinary buttons neutral filled by default; keep explicit primary, outline
  and the legacy default-as-primary variant.
- Refine studio typography, action descriptions and semantic color use; add
  searchable task views and details, conversation switching with per-chat drafts,
  expandable sources and accessible narrow-screen navigation.
- Include Lucide and Feather-derived icon notices in every distribution.
- Add `ChatViewport` with theme-aware bottom fade, safe end spacing, follow-latest
  behavior and an explicit return control while reading older messages.
- Auto-size the message draft from one line to 160px, then scroll within the field;
  coordinate composer resizing with the transcript without interrupting reading.
- Support delayed message anchors and share textarea sizing with the real app's
  mention composer; expose metric-card layout classes and align pill icons inline.
- Hide the transcript scrollbar on narrow and touch-first screens while preserving
  scrolling, keyboard access and the return-to-latest control.
