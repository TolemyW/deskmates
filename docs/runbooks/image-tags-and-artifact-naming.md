# Image tags and artifact naming

Date: 2026-09-25.
Scope: names for build and test artifacts — container images, evidence
directories, branches, git tags. Source-level names are in
[the naming upgrade](deskmates-naming-upgrade.md); runtime container, network and
volume names are computed in `packages/sandbox-docker/src/docker-provider.ts`
and are not restated here.

## What went wrong without a rule

On 2026-09-25 the development machine held 80 images, 39 of them pre-rename
`cogbot/*` workspace and egress tags, invented one per test campaign:
`m2-live-browser-hardening-v2-20260923`, `m2-live-closeout-20260924-r1` through
`-r6`, `b2-gate-20260923`, `verify-findings-20260924-sol-r2`, and so on. Three
observed consequences:

- **Duplicate tags on one image.** A fresh build of unchanged content produced
  image ID `4344306c2815`, which two existing tags already pointed at. The build
  cost nothing (every layer `CACHED`, 0 s) but the tag count kept growing and
  nobody could tell from the name whether two tags were the same bits.
- **Hand-copied identity in evidence.** Because a tag says nothing about its
  content, result documents record a nickname *and* a transcribed
  `sha256:` prefix. One closeout document notes that its recorded image ID
  differs from the ID in the handoff it audits — a bookkeeping failure that a
  content-derived tag makes impossible.
- **Tag ownership rules.** Agents sharing one daemon had to agree by convention
  not to overwrite each other's mutable tags.

## The rule

### Runtime images are content-addressed

```
deskmates/workspace:<arch>-<hash12>
deskmates/egress-proxy:<arch>-<hash12>
```

- `<arch>` is `amd64` or `arm64`. A macOS/colima build and a native Linux build
  of the same source are different bits and must never share a tag.
- `<hash12>` is the first 12 hex characters of a SHA-256 over the build inputs,
  in sorted path order:
  - for the workspace image: every file under `images/workspace/`, the
    `ARG` default values in its `Dockerfile`, and the build context the
    root `.dockerignore` admits — `packages/contracts/package.json`,
    `packages/contracts/dist/`, `packages/sidecar/package.json`,
    `packages/sidecar/dist/`;
  - for the egress image: every file under `images/egress/`.

Two properties follow, and they are the point of the scheme: the same source
always yields the same tag, so a second build is a no-op rather than a new tag;
and different source always yields a different tag, so two agents building
concurrently cannot destroy each other's image.

### Exactly two moving aliases

| Tag | Meaning | Who writes it |
| --- | --- | --- |
| `deskmates/workspace:dev` | the local working build | whoever ran `npm run image:workspace` last |
| `deskmates/workspace:main` | the last build of `origin/main` | CI, once it exists |

`dev` is deliberately unstable and is the default in
`acceptance/support/docker.ts` and `packages/sandbox-docker`. Nothing outside a
developer's own machine may depend on it. Both aliases are additional tags on a
content-addressed image, never a substitute for it.

### No per-campaign tags

A test campaign does not get its own tag. It records the content-addressed tag
it ran, which is reproducible from source. `r1`…`r6` style suffixes are not a
naming scheme: they encode the order someone happened to build things in, and
they are what produced six 3.6 GB tags of which several were byte-identical.

### Selecting an image for a test run

Acceptance suites and spike runners select the workspace image by Docker image
ID (`sha256:` plus 64 lowercase hex characters), never by tag. A tag is how a
human finds an image; the ID is what the run records and checks. Resolve one
with:

```
docker image inspect --format '{{.Id}}' deskmates/workspace:<arch>-<hash12>
```

The one predicate is `acceptance/support/image-id.mjs` (`isImageId`,
`requireImageId`, and a CLI for shell scripts that exits 2 on anything but an
ID). TypeScript suites call `requireWorkspaceImageId()` from
`acceptance/support/docker.ts`; `.mjs` runners and shell probes import or run
the same file. The earlier guard that required a `:m2-live-` substring in the
tag is gone, so a content-addressed tag or a per-revision tag is no longer
rejected for its name, and no tag is accepted in place of an ID.

### Evidence directories

```
spikes/<milestone>/<yyyymmdd>-<topic>-<hash12>/
```

`<hash12>` is the workspace image's hash, so the directory names the exact bits
it tested. When a campaign spans two images, name the workspace one and record
the egress one inside the manifest.

### Branches

```
<agent-or-owner>/<topic>-<yyyymmdd>
```

Already the de-facto rule (`codex/desktops-ui-20260923`). Tool-generated
`worktree-agent-<hex>` branches are disposable: delete them with their worktree.

### Git tags

Two kinds, both annotated.

**Milestone acceptance**, only for a milestone whose acceptance tests actually
passed:

```
m<N>-accepted-<yyyymmdd>
```

The tag message names the image hashes and the model the acceptance ran on. A
milestone with retained failures does not get a tag; the closeout document
carries the result instead.

**Releases** (added 2026-09-28), semver `vMAJOR.MINOR.PATCH`, for the stable
deployment. A patch release is gated by T0/T1 on CI and T2 on the target host;
a minor release that completes a milestone also runs that milestone's T3. The
release workflow pushes only `ghcr.io/<owner>/deskmates-workspace-base` under its
content-addressed suffix (`amd64-<hash12>`), and the release manifest pins it by
digest and image ID; the app layer and the egress proxy are built from the tag's
source on the target host under their own content-addressed tags. A release tag
is not a moving alias and not a per-campaign tag: it names one commit, and the
commit plus the pinned base determine the images. See
[the stable release runbook](stable-release.md).

The workspace base (`deskmates/workspace-base:<arch>-<hash12>`, from
`images/workspace-base/`) follows the same content-addressing rule; the
workspace tag's hash covers the base's hash, and `deskmates/workspace-base:dev`
is its local alias. A release resolves this tag in GHCR before building and
does not overwrite an existing manifest. Stable deployment prefers the
manifest's exact image ID, but may reuse an already installed image under the
same source-derived tag and records the actual ID in the release receipt. This
compatibility path handles older CI or authorized local builds whose image
metadata differs despite identical hashed inputs.

## Retention

Keep: the two aliases, any image backing a container, any hash cited by an
evidence directory still under review, and the base images
(`mcr.microsoft.com/playwright:v1.58.2-noble`, `alpine:3.20`, `node:22-alpine`).

Delete: everything else, and every dangling image
(`docker image prune -f`, which by design skips images a container uses).

**Never prune the build cache.** It is what makes an unchanged rebuild take 0 s.
It was 9.1 GB on 2026-09-25 and reported as 100 % reclaimable; reclaiming it
turns the next build into a ~5-minute cold build, and on a host whose containers
cannot reach the npm registry it turns it into a failure.

Note that `docker images` per-tag sizes are not additive. Removing 39 workspace
tags of a nominal 3.24–3.63 GB each moved the deduplicated total from 6.92 GB to
6.13 GB, because every workspace image shares the 2.66 GB Playwright base. Prune
for a legible inventory, not to recover space.

## Implementation notes

Status 2026-09-28: items 1 and 2 are implemented by `scripts/image-tag.mjs`,
`scripts/build-workspace-image.sh` and `scripts/build-egress-image.sh`; item 4
by `.github/workflows/release.yml` for release tags only (no per-commit image
builds, no `:main` alias yet). The original list:

1. A helper that prints the tag for the current tree, e.g.
   `scripts/image-tag.sh workspace|egress`, so that the build script, the test
   harness and a human all derive the same name from one place. The existing
   duplication hazard applies: one implementation, not one per caller.
2. `scripts/build-workspace-image.sh` uses it when `WORKSPACE_IMAGE` is unset,
   and additionally tags `:dev`.
3. `ensureWorkspaceImage` in `acceptance/support/docker.ts` skips the build
   when a tag exists, so content-addressed tags make a repeat run free with no
   further change there. Given an image ID it never builds: an ID absent
   locally, or combined with `DESKMATES_REBUILD_WORKSPACE_IMAGE=1`, fails closed,
   because no build can produce a given ID.
4. CI builds both images per commit on `amd64`, pushes them to a registry with
   `--cache-from`/`--cache-to`, and tags `:main`. This is also the only route to
   an `amd64` image on a host whose containers cannot reach the npm registry,
   which is the current blocker on ADR-0009's required native-Linux evidence.
