# packages/web/scripts

## `ui-fingerprint.mjs`: did the UI move?

A regression oracle for changes that must not change what the operator sees: moving CSS,
splitting modules, renaming internals. It captures the standalone demo (`demo.html` on the
in-browser MockGateway; no Gateway, no network) and compares two captures element by element.

```
# from the repository root
node packages/web/scripts/ui-fingerprint.mjs capture <outDir> [--no-build] [--dist <dir>] [--jobs N] [--only <regex>]
node packages/web/scripts/ui-fingerprint.mjs compare <dirA> <dirB> [--limit N] [--pixel-tolerance N] [--faint-pixels N]
```

Typical use: capture the base commit once, then capture your branch and compare.

```
git switch --detach <base> && node packages/web/scripts/ui-fingerprint.mjs capture ../fp-base
git switch -              && node packages/web/scripts/ui-fingerprint.mjs capture ../fp-head
node packages/web/scripts/ui-fingerprint.mjs compare ../fp-base ../fp-head
```

Keep capture directories outside the repository (or under the ignored `tmp/`): they hold a few
hundred files.

### What `capture` does

1. Builds the demo (`DESKMATES_DEMO=1 vite build` into `packages/web/dist-demo`) unless
   `--no-build`, and serves it on a random local port.
2. Finds a thread, a run, a contact and a task id by following the demo's own links.
3. Visits every screen: home, the chat list and each thread, a run, contacts (list, a bot, the
   bot's Experience/Your notes/Settings tabs, `contacts/new`), channels, desktops, tasks (list and
   one task), approvals, files, knowledge documents and observations, skills, computer, trash,
   costs, integrations, members (the demo person is the owner), account, the open workspace
   switcher, the operator manual, sign-in and an invitation. Each screen is opened at 1440x900,
   1024x768 and 390x844, in the light and the dark theme: one state per combination, each in a
   fresh browser context.
4. Records per element (everything under `<html>` except `<head>`): a DOM path of tag names and
   sibling indexes, tag, own text, all attributes, the bounding box, scroll offsets, form values,
   the full computed style and the computed style of `::before`, `::after`, `::marker` and
   `::placeholder` where they exist. Styles are stored as the difference to the browser default of
   the same tag (lossless; `compare` rebuilds the full style). Plus a full-page screenshot.
5. Writes `meta.json`, `states/<screen>@<viewport>-<theme>.json.gz`, `shots/*.png`,
   `dom/*.html.gz` (the serialised DOM, for tools that ask which elements a selector matches;
   `compare` does not read it) and the built `demo.css`.

Determinism: a fixed wall clock (`page.clock.setFixedTime`), `en-US`, UTC, a seeded
`Math.random` (React Aria ids, the mock's latencies), the theme forced through both the colour
scheme and the stored preference, software rasterisation on one thread, no CSS transitions and
zero-length keyframe animations while the page loads (the suppressing sheet is removed before
recording, so computed styles keep the real values), a DOM that has stopped changing, decoded
images and loaded fonts, finished animations, a fresh layout pass (every scroll container is set
to `overflow: hidden` for one layout and restored, so a classic scroll bar left over from a
moment when the content was taller is decided again; a drawer was bistable without it) and a
full repaint, and a screenshot retaken until two consecutive shots agree, with the page recorded
before and after the shots and the round repeated until both records agree (screens that poll).
The local server's origin and object URLs are normalised. Two captures of the same commit
compare equal, also on a busy machine; if they do not, that is a harness bug.

One noise source is left: on a heavily loaded machine a rotated 16px icon (the chevron of a
closed "Earlier activity" disclosure) can come out with about ten edge pixels a few levels
different. `compare` therefore treats a pixel whose channels all differ by at most 16 as faint,
and up to 64 faint pixels per screenshot as antialiasing noise: listed, not counted. More faint
pixels count in full, and element data is always compared exactly. `--pixel-tolerance 0`
compares pixels exactly; `--faint-pixels N` changes the allowance.

Fixture shim: at `76bb036b` the demo's skills view omits `starterSkills` and the Skills screen
throws. The harness fills an empty list when the field is missing, so the screen renders and is
compared; a demo that sends the field passes through unchanged.

### What `compare` reports

Missing or extra states and elements, and per element every differing tag, text, attribute, box,
scroll offset, value and computed property (with both values), plus the number of differing
pixels per screenshot. It exits 1 on any difference, 0 when everything is equal. `--limit` caps
the lines printed per state (default 25); the totals always count everything.

### Limits

Only what the listed states render is compared: hover and focus states, other dialogs, other
tabs and data the demo does not seed are not. The DOM path uses tag names and sibling indexes,
so a change that adds a wrapper element shows as many differences; that is intended for a
refactor that must not change the DOM. Pixels depend on the machine (fonts, Chromium build):
compare captures made on the same machine with the same browser; `compare` flags a browser
version mismatch.

Playwright resolves from this repository (`spikes/s0/node_modules`, also from the main checkout
when run in a git worktree) or from `PLAYWRIGHT_MODULE`; Chromium from Playwright, from
`PLAYWRIGHT_CHROMIUM`, or the newest headless shell in `~/Library/Caches/ms-playwright`.
A full capture (192 states) takes about 3 minutes on an idle laptop with `--jobs 6`, about 6 to
7 minutes on a loaded one; `compare` takes under a minute. `--dist <dir>` captures an already
built demo (for example one built from another commit) instead of `packages/web/dist-demo`.

Tailwind scans this directory for class candidates. A word in this README or in the script that
names a utility adds that utility to the built stylesheet, which a capture then shows. Keep
both free of such words, or check `demo.css` of two captures when editing them.
