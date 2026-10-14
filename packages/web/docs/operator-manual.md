# Bundled operator manual (2026-10-10, issue #28)

The one Help entry opens `docs/guide/` inside the app (`src/components/operator-manual.tsx`).
The pages are imported by name in `src/lib/guide-manifest.ts`, so each build carries the guide
of its own commit; there is no runtime fetch, Gateway documentation service or GitHub request.
`guide-manifest.test.ts` fails when docs/guide/ and the manifest disagree: a new guide page
needs an import line there. Links resolve in `src/lib/guide-links.ts`: manifest pages and
anchors become in-app navigation, other repository paths become explicit GitHub links at the
built release, everything else is text; images load only from the manifest's asset list.
`vite.config.ts` reads the release directory's `release-manifest.json` so About can compare the
manual's release with the one the Gateway reports; a working-copy build says it is a
development build. The manual overlays the work area, which stays mounted and `inert`, so
drafts and scroll survive. It has no focus trap. "This screen" uses `screenGuidePage` in
`src/lib/guide.ts`. Each feature's `route.ts` names the guide page of every route it owns
(`screens`) and its `shown` redirect; the shell and the manual both resolve the screen through
`shownRoute` (`src/app/route-registry.ts`), so they cannot drift apart.
