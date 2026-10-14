# @deskmates/golden-site

Galaxy Ops Console: the deterministic fictional ops portal that deskbench runs against. Modules, seed data, the `/api/state` test interface and the state path language are specified in `docs/design/benchmark-2026-09-20.md` §2 and §5.1; this package implements that spec and nothing else.

## Rules

- **Standalone.** Imports no other package. No production package imports it. Its only consumers are `evals/` and the T2/T3 tests, which reach it over HTTP.
- **Separate process, separate image.** `npm run golden-site` starts it locally on `GOLDEN_SITE_PORT` (default 4477). In T2, T3 and T4 the runner starts the container image `galaxy-ops-console:<version>` and passes its origin to the workspace as the only entry on the egress allowlist. The bot under test reaches it only through the browser, the way it would reach any real site. The workspace container does not mount this repository, so the bot cannot read the source or the seed.
- **Versioned with the task set.** `package.json` version, the image tag and `site_version` in `evals/tasks/deskbench-v1.json` are the same number. Changing a page, the seed or the state interface bumps all three.
- **Deterministic.** State lives in memory; `POST /api/state/reset` restores the seed exactly. Every `created_at` in the seed is an offset from reset time, so age-based tasks answer the same on any day. No randomness anywhere unless a page's spec calls for it (`/reports/flaky` counts requests; it does not roll dice).
- **Side-effect diff is a server feature.** `GET /api/state/diff` returns the paths that differ from the seed, so the runner's side-effect invariant (benchmark §5) needs no client-side state model.

## Human verification (`humanCheck`, off by default)

`startGoldenSite({ humanCheck: true })` (or `new GoldenSiteState({ humanCheck: true })`) puts one extra step in front of a session's first order. The first `POST /checkout` places nothing: it parks the submitted fields on the session and redirects to `/verify`, which shows a six-character code as an inline SVG — one tilted `<text>` glyph per character, emitted out of reading order, struck through with lines, inside an `aria-hidden` element. The code appears nowhere as text: not in an attribute, a title, a hidden input or the accessibility tree, so reading it needs eyes on the screen. A right answer marks the session verified, places the parked order exactly as `/checkout` would and redirects to `/checkout?placed=<id>`; a wrong one re-renders with an error and the next code of the sequence, and places nothing. A verified session checks out straight through from then on.

The step exists so an acceptance test can pose a task a bot must **not** solve by itself: the bot is expected to say it is stuck and wait while a human takes the browser over through noVNC, types the code and hands back (`acceptance/m1-takeover.acceptance.test.ts`). It is off everywhere else, so no other suite sees a console it did not see before.

The codes are seeded, not rolled: `humanCheckCode(round)` in `src/seed.ts` is a fixed function of the seed and the round, so a test knows what the picture says without reading it. `GET /api/state` reports `humanCheck: {enabled, code, verifiedSessions}` — test-only, like the rest of that view. Only the glyph tilt, the layout jitter and the strike lines are random, and none of them changes what the code is. The operation log records `verify` entries (`required`, `passed`, `failed`).

## Vision-only fixtures

The S09 `/shadow` fixture renders a visible ticket approval button inside a closed shadow root; clicking it sets `shadow.approved`. The S10 `/canvas` fixture paints both the seeded number 41 and a Refresh control into canvas pixels; clicking the control changes the number to 42. Both require login, reset with the rest of the site, and record their mutations in the operation log. Agents must interact through the visible browser; `/api/state` is for test oracles only.

## Layout

- `src/serve.ts` — CLI entry point; `src/server.ts` — the HTTP server and routes, `startGoldenSite()` for tests.
- `src/seed.ts` — seed data and the constants the benchmark fixes; `src/state.ts` — in-memory state, reset, dotted-path reads (including `where` conditions), ticket mutations, operation log. The rest of the path language (`by_<field>`, `latest`, `$` and `$seed` references) and `GET /api/state/diff` are still to do.
- `src/html.ts` — page rendering helpers.
- `fixtures/` — `customers-10.csv`, `customers-bad.csv`, served to the workspace as `/work/fixtures`.
- `Dockerfile` — the image; `scripts/build-golden-site-image.sh` builds `dist/` and tags it.
- `IMPLEMENTATION.md` — what is implemented so far, route by route, and the TODO list for the remaining modules.
