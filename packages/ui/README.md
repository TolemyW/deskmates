# @deskmates/ui

Deskmates's independently versioned component library, built on HeroUI v3 and
React 19. The public API, compositions and release notes belong to Deskmates. HeroUI owns
the default visual design: keep its palette, radii, shadows and component sizing.
See [ADR-0025](../../docs/adr/0025-owned-heroui-component-library.md).

## Responsibility and boundaries

- Own reusable presentation and accessible interaction, never application state.
- Import no Deskmates workspace package, Gateway client or runtime service.
- Accept values, children and callbacks. Business status mappings stay in web.
- Export named components from `src/index.ts`; consumers do not import internals
  or HeroUI directly. Import `@deskmates/ui/styles.css` after Tailwind CSS v4.
- Keep `--gb-` tokens as aliases to HeroUI tokens, not a replacement theme.
- Limit `gb-` styles to composition/layout and state affordances. Do not override
  upstream control colors, radii, shadows, typography or sizes.
- Preserve native form semantics and disabled behavior when adapting HeroUI.
- Add a studio example for every component and test meaningful interaction contracts.

## Independent workflow

From the repository root:

```sh
npm run dev:ui                 # http://127.0.0.1:6006
npm run typecheck -w @deskmates/ui
npm run test -w @deskmates/ui
npm run build -w @deskmates/ui    # ESM, declarations and CSS in dist/
npm run build:ui-studio        # static preview in packages/ui/dist-studio/
```

The studio uses local fixtures only; it needs no Gateway, account, Docker or model.
It opens with a native HeroUI component gallery, plus foundations, chat and task compositions, with
light/dark themes and a narrow viewport layout. Examples are not production data.

## Consume

```tsx
import { Button, Input, Pill } from "@deskmates/ui";

<Button variant="primary" onClick={save}>Save changes</Button>
<Input aria-label="Task title" value={title} onChange={onChange} />
<Pill tone="warning" dot>Waiting for you</Pill>
```

```css
@import "tailwindcss";
@import "@deskmates/ui/styles.css";
```

Set `data-theme="light"` or `data-theme="dark"` on the document root. HeroUI styles
are imported here once; consumers must not import a second copy. Application styles
must not redefine the library's `gb-` classes. ADR-0025's owner amendment
permits the web application's centralized typography adapter; it does not change
these native library defaults or the component studio. `Button` defaults to `type="button"`;
use `type="submit"` explicitly for forms. Ordinary buttons and links default to
neutral `tertiary`; primary actions use `variant="primary"`. The legacy `"default"`
variant remains an alias for primary; prefer the explicit name in new consumers.
Use `outline` only when an outlined action is intended. `ButtonLink` provides anchor semantics.
Legacy callers that supply a tab/menu role retain native button semantics and
HeroUI visual variants; their parent still owns composite keyboard navigation.
`Switch` and `Checkbox` expose owned labelled, controlled APIs. `Tabs`, `Slider`,
`Label` and `Spinner` are vetted native exports; their upstream composition APIs
are part of this package version.

`Avatar` supplies a circular username fallback: `<Avatar name="Atlas Research" />`.
Its color is a deterministic hash of the normalized username into HeroUI's native
accent, success, warning, danger and default soft palettes. The matching foreground
tokens adapt to light/dark mode. Case, surrounding/repeated whitespace and equivalent
Unicode forms do not change the assignment; different names may share a color.
Colors indicate identity only, never status. Use the same full name at every size
(`md` or `sm`); display-name changes may change the color. Empty names show `?`.

`BrandMark` renders the Deskmates icon, a 256 px square transparent PNG in
`src/assets/deskmates-logo.png` cropped to the artwork's edges, at its own colors and at
`size` pixels a side, so `size` is the glyph's size. The image is decorative and not
draggable. Use `<BrandMark size={28} />` beside an accessible brand name. The PNG is
included in package builds.

`MessageComposer` is an owned multiline chat composition: provide `value`,
`onChange` and `onSend`; optional `context` sits beside the send control. Enter
sends a nonempty draft, Shift+Enter inserts a line break, and IME confirmation
does not send. The callback receives trimmed text, then the draft is cleared.
`disabled` blocks editing and sending. This composition uses a native textarea
and the shared Button; it is not an upstream chat template.

`Icon` provides a consistent decorative Lucide outline icon (20px, 1.8 stroke by
 default). Give the containing button a visible label or `aria-label`.
`WorkspaceLayout` owns the shared sidebar/header/content frame. Pass `title`,
`navigationLabel`, `sidebar(close)` and children; optional `subtitle` and `actions`
fill the header. At narrow widths the sidebar becomes a native modal dialog with
Escape dismissal and focus restoration. The sidebar is rendered in both desktop
and dialog containers: use unique IDs with `useId` in sidebar child components.
`MetricCard` composes a label, value and optional detail on a native card surface.
The studio demonstrates both compositions with local chat and task state.

## Versioning and extraction

### Upstream license

HeroUI v3 uses Apache-2.0; the official
[v3.0.3 release notes](https://heroui.com/en/docs/react/releases/v3-0-3)
record the change from MIT. The installed `@heroui/react` and `@heroui/styles`
3.2.6 LICENSE files both contain Apache-2.0, although their package.json license
fields still say MIT. Do not infer the v3 license from that stale metadata or the
older main-branch license. Keep applicable license, copyright and NOTICE material
with distributions, and mark changes to upstream files if modifying them.
The studio's product branding does not replace these legal notices.

The original HeroUI license and a scoped attribution are retained in `legal/`.
Library, studio and web builds copy them into `third-party/`; the npm package
includes them under `dist/third-party/`. The two installed 3.2.6 packages have
identical LICENSE files and no separate NOTICE file. On an upstream upgrade,
recheck both packages and update this material before distributing builds.
Lucide’s complete installed license (including the Feather-derived icon notice)
is retained alongside it and copied by the same build pipeline. This is not a
license audit of all transitive dependencies.

### Package releases

Version `0.1.0` is private and unpublished. Record each consumer-visible change in
`CHANGELOG.md`: patches for compatible fixes, minors for additive APIs and majors
for breaking APIs (including during 0.x). Pin the application to the package version
and update it intentionally. There is no automatic public publishing.

`npm pack --dry-run -w @deskmates/ui` checks the distributable file inventory after a
build. Only `dist`, README and changelog ship; the studio and test fixtures do not.
The package keeps its own build/test configuration and declares all dependencies,
so extraction later means moving this folder, installing its dependencies and
updating consumers to the private registry or Git source chosen by the owner.

## Migration boundary

The first migration covers shared buttons, inputs, pills and empty states. Task
editor fields also use the owned inputs. Existing Radix desktop dialogs and tooltips
remain in web until their interaction and live-screen lifecycle are migrated and
verified separately. This package does not imply a completed application redesign.

## Chat scrolling and composer sizing

`MessageComposer` starts with a 28px text field, grows with the controlled draft
and available width, and caps at 160px with internal scrolling. Emptying it restores
the compact height. Enter/Shift+Enter and IME behavior are unchanged.

`ChatViewport` accepts a `conversationKey`, message `children`, and a `composer`
React node (including any surrounding footer). Place it inside a flex column with
bounded height. It owns the scroll region, end spacing, background fade and
“Back to latest” control. It starts a conversation at the latest content, follows
updates/resizes while at the end, and preserves the scroll position while reading
older content. Keeping the composer in this composition lets draft resizing settle
before updating the scroll position. Application data and incoming messages remain
consumer-owned; this component does not fetch or submit messages.

## Application chat integration

`ChatViewport` accepts an optional `scrollTargetId` to reveal a message after it
loads, once per target and conversation. Subsequent updates preserve the reader's
position. `useAutoSizeTextarea(value)` returns a textarea ref for consumers with
their own mention picker and submission logic. It shares the composer's sizing
behavior without owning the consumer's draft or sending messages. `MetricCard`
accepts `className` for application-specific layout.

`Select` owns a single-value dropdown and its themed popup. Pass `label` (or
`aria-label` without a visible label), `value`, `onValueChange`, and `options`
(`value`, `label`, optional `disabled`). An empty string can be a selectable
“All”/“Unassigned” option. `name`, `required` and `disabled` preserve form semantics;
pass a containing fieldset's disabled state explicitly.

`Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead` and `TableCell` compose
semantic HTML data tables with HeroUI table surfaces and slots. Use `aria-label`
or a caption to name each table. The wrapper contains horizontal overflow and is
keyboard scrollable; cells preserve native controls and `colSpan` for empty states.
The default primary variant groups rows on a surface; secondary suits Markdown.
These are data tables, not selectable/sortable ARIA grids.

`ResizeHandle` is a controlled vertical separator. Supply `label`, pixel `value`,
`min`, `max` and `onChange`; `reverse` places it on a right panel’s left edge.
The positioned parent owns layout, available space and optional persistence.
Arrow keys resize by 16px; Home/End select the bounds. Pointer capture ends
on release or cancellation.

`Pager` is a presentational Previous/Next bar for a bounded list page. Pass `label` (the
navigation name), `previousLabel`, `nextLabel`, a caller-formatted `range` (for example
"26–50 of 80", or "26–50 of more" when the source has no cheap total), `hasPrevious`,
`hasNext` and the two callbacks; `busy` disables both while a page loads. It owns no paging
state, cursor or strings; the web application's `usePagedQuery` hook owns those.
