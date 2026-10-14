# v0.4.0 deployment verification

Date: 2026-10-10. Host: Testbox, internal stable trial deployment.
Authorization: AGENTS.md, Stable release deployment on Testbox; owner request to release 0.4.0.
This is an ordinary minor release, not M4 milestone acceptance.

## Release and checks

- Annotated tag: `v0.4.0`.
- Source: `54ac759ba54c89c2768323f9ad05d0830bcd5844`.
- Source archive SHA-256: `21837a0d4907ae6626a84338ced11806b77f0cfcf79ffe51042e907b263e203b`.
- [Release CI](https://github.com/TolemyW/deskmates/actions/runs/37967634148): gate, base and publish all passed.
- [Published release](https://github.com/TolemyW/deskmates/releases/tag/v0.4.0).
- Local typecheck, lint, documentation, UI and unit/integration evidence is in
  [the UI verification receipt](ui-release-v040-verification-2026-10-10.md).
- Shipped the tagged archive and manifest with `LOCAL_BASE=1`. Installed with a fresh
  `npm ci` using the npm mirror, then built Gateway and web on Testbox.

## Image identity and full container gate

The documented local-base fallback built the unchanged base Dockerfile on Testbox.
It is source-equivalent by the deployment script's content hash, not byte-identical to CI's image.

| Image | Identity on Testbox |
| --- | --- |
| Base, `amd64-afd228b644f2` | `sha256:bffdc561d23361c6d199f62981b7543cc55f476bc28ef505da16207f700a61f5` |
| Workspace, `amd64-8c403e3e4530` | `sha256:19286e8f00474931874e457e83f8b846ab1d4bd670983c85d232183f10b10231` |
| Egress, `amd64-7d91517883a7` | `sha256:37d262a80778dcdb693179d20da247b09c97ad1ca48a504d74096de865e2f9b6` |

CI's manifest base image ID is
`sha256:3fd8baf8944f1f211d7d2de45476131d5f8de6a807d7d244bb9149ca0d91b77a`.

`T2_MAX_WORKERS=2 T2_SCOPE=full stable.sh verify v0.4.0` passed:
31 files, 101 tests passed, 1 skipped; exit code 0. Started 2026-10-09 17:55:04 UTC,
finished 18:01:43 UTC; Vitest duration 398.48 seconds. The single skipped case is the
optional real-model SDK call in `sdk-shape.container.test.ts`; model credentials are
explicitly removed by the release verifier. No real-model calls were made.

Receipt and complete file inventory:
`/home/owner/Data/deskmates-stable/releases/v0.4.0/.release/t2.json`;
log: `.release/t2.log` in the same release directory.

## Activation and post-checks

- Activation found zero active runs and did not force a shutdown.
- Database backup: `/home/owner/Data/deskmates-stable/backups/20261009T180213Z-v0.3.7-to-v0.4.0`.
- Activated at 2026-10-10 02:02:13 Asia/Shanghai (2026-10-09 18:02:13 UTC).
- Current release and authenticated config report `v0.4.0`; previous is `v0.3.7`.
- Gateway health and systemd service state passed. No application warning/error/fatal
  log lines were observed in the immediate post-activation check.
- UI HTML returned HTTP 200. Both referenced build assets returned HTTP 200 and matched
  the installed release bytes: `index-DF04QUdI.js` (SHA-256 prefix `43eb175cf88e`) and
  `index-CN53XlN7.css` (`8c38acadecc2`).
- `shared/.env` SHA-256 remained
  `4764e15140ee137899416dc40fbc1d0be08f1f75012ff9908d966cf4a2fa33b5` before and after activation.
  Credentials, encryption key and existing configuration were not replaced. Caddy and the
  integration runtime were not modified.

Visual checks were on the local mock Gateway, as recorded in the UI verification receipt.
Authenticated browser interaction against the stable instance and real-model/T3 milestone
acceptance were not run by this release session. Future account, invitation, Resources and
alert-layout issues are not claimed complete by this release.
