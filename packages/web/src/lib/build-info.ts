// What this web bundle was built from (issue #28). `vite.config.ts` reads the release directory's
// `release-manifest.json` (scripts/stable/stable.sh builds the UI inside releases/<tag>/) and
// defines `__DESKMATES_WEB_BUILD__`. A working-copy or test build has no manifest, so its release
// is null and the manual says it is a development build rather than claiming a version.

export interface WebBuild {
  /** The release tag the bundle was built for, e.g. `v0.4.0`; null for a development build. */
  release: string | null;
  /** The commit of that release, when the manifest names it. */
  revision: string | null;
}

declare const __DESKMATES_WEB_BUILD__: WebBuild | undefined;

export const WEB_BUILD: WebBuild =
  typeof __DESKMATES_WEB_BUILD__ === "undefined" || __DESKMATES_WEB_BUILD__ === undefined
    ? { release: null, revision: null }
    : __DESKMATES_WEB_BUILD__;
