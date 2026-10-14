# ADR-0025: An independently maintained Deskmates UI library on HeroUI

Date: 2026-10-09
Status: Accepted (owner selected HeroUI and an independent package with a preview site)
Implementation: initial package and shared-control migration implemented locally;
verification recorded in [the UI library receipt](../design/ui-library-verification-2026-10-09.md).
Amends: ADR-0008 decision 7's component technology only.

## Context

The owner requested HeroUI and a Deskmates-owned component library that can evolve
independently. The owner selected a package in this monorepo with its own preview
site, rather than a separate Git repository. The current web application owns
Radix/shadcn-style primitives and a large application stylesheet. Moving application
state into a shared library would prevent independent use and make extraction harder.

## Decision

1. Own `@deskmates/ui` in `packages/ui`, based on HeroUI v3. It has an explicit public
   entry point, stylesheet, version, changelog, build, typecheck and tests. React
   is a peer dependency. HeroUI is an implementation dependency; consumers import
   Deskmates components. This replaces the Radix/shadcn choice in ADR-0008 decision 7
   for migrated components. Existing desktop dialogs may retain Radix during migration.
2. Permit the frontend-only dependency `web -> ui` as an explicit exception to the
   original contracts-only workspace dependency rule. UI imports no other Deskmates
   package, app state, Gateway client or runtime service. Domain mappings, session
   state and network actions stay in web; UI receives values and callbacks.
3. Provide a standalone Vite component studio inside `packages/ui/studio`, with
   foundations, interactive states and product compositions using local fixtures.
   It runs without a Gateway, credentials, Docker or model. It is excluded from the
   library distribution. Light/dark and narrow layouts are reviewable there.
4. Migrate existing shared buttons, inputs, generic pills and empty states through
   the owned public interface first. Preserve native form submission, disabled
   behavior, accessible labels and application-controlled actions. Do not claim a
   complete screen redesign or milestone visual acceptance from this migration.
5. Preserve HeroUI’s native visual design. The owner supplied the HeroUI homepage
   as the visual reference and rejected the initial custom gray/green reskin.
   Library color tokens are aliases, not replacements; do not override native
   control colors, radii, typography, sizes or surface shadows. Scope legacy web
   tokens separately to prevent them from changing the library’s appearance.
   Owner amendment (2026-10-10): the application may adapt typography through a
   single, scoped type scale to resolve mismatched legacy and native font sizes.
   Use rem-based tokens: 13px equivalent supporting text, 15px body/controls,
   18px section headings, 22px page titles and 24px metrics at a 16px root.
   This is a web application typography exception; the component studio retains
   native defaults, and colors/radii/shadows are not changed by this exception.
   Owner amendment (2026-10-10, dark-field review): application input and textarea
   fields may use a 1px neutral outline and the native secondary surface token in
   dark mode so empty controls remain distinguishable from their containing card.
   Preserve native focus, invalid and disabled behavior; this scoped contrast
   adjustment does not change the component studio theme.

## Verification

| Item | Concrete meaning | Required verification | Metric |
| --- | --- | --- | --- |
| 1 | Independently built ESM/types/CSS with explicit exports | UI build, typecheck and npm pack dry run | Build failures; accidental studio files in package |
| 2 | UI has no application or server dependencies; web owns upstream integration | `packages/ui/src/package-boundary.test.ts` | Forbidden imports (zero) |
| 3 | Fixture-only studio renders themes and responsive compositions | Studio build; `spikes/ui-library-20261009/verify.mjs` browser checks | Page errors; horizontal overflow; interaction failures |
| 5 | Native appearance survives the owned API and legacy integration | UI native-style boundary test; studio and web browser screenshots | Unexpected appearance overrides (zero outside the scoped application typography exception); visual comparison |
| 4 | Consumer forms and disabled actions retain behavior | UI interaction tests and existing web tests; web build | Regression failures |

## Consequences

The package can evolve through explicit semver changes and later be extracted to
another repository. It remains private and unpublished initially. The application
and studio consume the same source during development; the package build produces
the distribution for other consumers. Global application styles must not override
owned components except the documented, scoped application typography adapter. No agent strategy, runtime, deployment or approval policy changes.
