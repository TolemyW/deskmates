# Stable release records

What was verified for each release of the long-lived stable deployment on Testbox, and other
dated facts about that deployment. The procedure is the
[stable release runbook](../runbooks/stable-release.md); this directory is its log.

## Rules

- **One file per verified release, never append to a shared log.** A release that is installed,
  verified, activated or rolled back gets its own file; later facts about that same release go in
  that file. A fact that belongs to no single release (a host network finding, a model change, a
  test-gate change) gets its own dated file.
- **Name:** `YYYY-MM-DD-<subject>.md`, where the date is the day of the first entry and the
  subject is the release tag (`2026-10-10-v0.5.3.md`) or a short kebab-case topic
  (`2026-09-28-testbox-network.md`). Files sort by date; within one day the name is not a
  release order (`v0.2.13` sorts before `v0.2.6`), so read the tags.
- **Content:** a `# <tag or topic>` heading, then the entry: date, what was activated or
  installed, source commit, gates and their numbers (files, tests, seconds), receipts, backups,
  exceptions and what was not yet done live. Link design results with `../design/...` and runbook
  steps with `../runbooks/...`.
- The moved files that hold more than one entry keep them in the order the old shared log had,
  so "above" and "below" between them stay true. New entries in a file go at its end.
- Records are history: do not rewrite an old file to match a later release. Correct it with a
  dated note in the same file or in the new release's file.

The files up to `2026-10-10-v0.5.3.md` were moved verbatim from the runbook's former
"Verified so far" section on 2026-10-13.

## Not yet verified

- A GHCR base transfer. Record it in the file of the release where it happens.
