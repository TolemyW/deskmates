# Deskmates naming upgrade

The product is **Deskmates**, the root npm package is `deskmates`, and workspace
packages use `@deskmates/*`. The repository is already named `deskmates`.
Galaxy Ops Console and deskbench keep their names: they identify the test website
and evaluation suite, respectively.

This is a coordinated source rename, not an automatic migration of a running
installation. Build and deploy the Gateway, workspace image and egress image
together. Merely retagging an old image does not update its binaries, environment
variables, paths or labels.

## Names that change

| Previous name | Current name |
| --- | --- |
| `CogBot`, `cogbot`, `@cogbot/*` | `Deskmates`, `deskmates`, `@deskmates/*` |
| `CogbotError`, `isCogbotError`, `app.cogbot` | `DeskmatesError`, `isDeskmatesError`, `app.deskmates` |
| `COGBOT_*` | `DESKMATES_*` |
| `cogbot-sidecar`, `cogbot-healthz`, `cogbot-entry` | `deskmates-sidecar`, `deskmates-healthz`, `deskmates-entry` |
| `mcp__cogbot__*` | `mcp__deskmates__*` |
| `cogbot/workspace:*`, `cogbot/egress-proxy:*` | `deskmates/workspace:*`, `deskmates/egress-proxy:*` |
| `cogbot.*` Docker labels | `deskmates.*` Docker labels |
| `cogbot-ws-*`, `cogbot-net-*`, `cogbot-egress-*` | `deskmates-ws-*`, `deskmates-net-*`, `deskmates-egress-*` |
| `cogbot-<workspaceId>-profile/work/home` volumes | `deskmates-<workspaceId>-profile/work/home` volumes |
| `/opt/cogbot`, `/run/cogbot`, `/run/cogbot-egress` | `/opt/deskmates`, `/run/deskmates`, `/run/deskmates-egress` |
| `<bot-home>/.cogbot/browser` | `<bot-home>/.deskmates/browser` |

## Fresh checkout

Run `npm install` to refresh workspace links, then `npm run build`. Configure the
new environment names using `.env.example`; keep existing secret values private.
Build the runtime images from this checkout:

```sh
WORKSPACE_IMAGE=deskmates/workspace:dev npm run image:workspace
docker build -f images/egress/Dockerfile -t deskmates/egress-proxy:dev .
```

Set `WORKSPACE_IMAGE` and `EGRESS_PROXY_IMAGE` to those newly built images when
starting the Gateway. Its default database path remains `./data/gateway.sqlite`.

## Existing installation

The source change does not edit a local `.env`, database, saved SDK session,
Docker resource or browser profile. Runtime names have no legacy compatibility
aliases. The UI alone recognizes the two old attachment MIME types so that
historical approval cards and handoff links remain readable; new messages always
use the new MIME types.
Before switching a stateful installation:

1. Quiesce scheduled work and finish active runs, including parked approvals,
   with the old stack. Back up the stopped Gateway database and workspace volumes.
2. Rename configured `COGBOT_*` keys to `DESKMATES_*` and select rebuilt images.
   Do not copy credentials into tracked files.
3. Preserve each workspace's profile, work and home data in the corresponding
   new volume names, retaining ownership and permissions. Docker volumes cannot
   be renamed in place. Recreate containers and networks under the new names;
   the new provider does not adopt containers bearing the old names and labels.
   Starting it before copying the data can create empty new volumes.
4. Use new threads after the cutover to begin new SDK conversations; continuing
   an existing bot/thread pair automatically resumes its saved session. Old sessions and browser
   continuation metadata refer to the previous tool namespace and container
   targets; copying that metadata does not make it safe to resume.
5. Review and recreate any stored approval rules that match the old MCP tool
   names. Historical approvals, run events and recorded traces remain evidence
   of the old runtime; do not bulk-replace strings in the database or original
   trace files. A replay adaptation, if needed, must use a separately identified
   copy and account for the namespace change.
6. Verify the migrated installation before removing any old resources or backups.
   The renamed deployment helper targets the new resource prefixes and does not
   clean up the old installation automatically.

## Historical names

Historical result documents retain recorded image tags, tool identifiers and log
paths. Existing `docs/design/design-cogbot-*.md` filenames and references remain
stable under the repository's no-rename rule, and the frozen Chinese drafts are
unchanged. These occurrences document history rather than current runtime names.

Source-level checks do not establish container or live-model acceptance after
the rename. Those checks require the rebuilt images and their own recorded results.
