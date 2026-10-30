# Public mirror

Deskmates is developed in a private repository and published to a public one. The two
share one history, so publishing is a fast-forward push, never a re-scrub.

## The two remotes

| Remote | Role | Who pushes |
|---|---|---|
| `origin` | private repository: daily work, draft PRs, CI, private branches | everyone |
| `public` | public repository `TolemyW/deskmates`: `main` and release tags only | whoever publishes |

```bash
git remote add public git@github.com:TolemyW/deskmates.git
git config core.hooksPath scripts/git-hooks     # once per clone
git push public main                             # publish; fast-forward only
git push public v1.2.3                           # publish a release tag
```

The pre-push hook runs `scripts/public-scan.mjs` whenever the target is the public
remote and refuses the push if a tracked file carries a blocked identifier.

## What never enters a tracked file

Private host names, LAN addresses, people's names, private e-mail addresses and the
former product name. `scripts/public-scan.test.mjs` fails on any of them, in every
`npm test`, private CI included; `scripts/public-scan-blocklist.json` stores sha256
hashes of the tokens so the list itself names nothing. Add a token with:

```bash
node scripts/public-scan.mjs --hash <token>
```

and paste the hash into the blocklist. Short tokens can be brute-forced from the hash;
the list protects against accidents, not against a determined reader, so still prefer
placeholders (`testbox`, `example-corp.internal`, `10.88.x.y`) in prose.

Material that needs the real names goes elsewhere:

- spike code, campaign receipts, screenshots and logs: the private lab repository;
- deployment specifics (hosts, ports, paths): the deployment's own `.env` and the
  operator's notes, never a runbook;
- `tmp/` is ignored by git and is fine for local scratch.

A design document in this repository cites lab material by date and title, never by
path or host.

## One-time re-root

The private repository's old history names people and hosts in every commit and
carries the removed material. Publishing therefore starts from a new root commit,
which also becomes the private `main`:

```bash
git checkout public-release-prep                 # the cleaned tree, prune applied
git checkout --orphan public-main
git -c user.email=<id>+<login>@users.noreply.github.com commit -m "Initial release of Deskmates"
git branch -m main archive/pre-public-history    # old history stays, private only
git branch -m public-main main
git push --force origin main                     # private repository
git push origin archive/pre-public-history
git push --force public main                     # public repository
```

`git checkout --orphan` keeps the index, so untracked files and unstaged edits stay
out of the root commit. Use the GitHub noreply address as the author so no private
e-mail enters the public history, and turn on "Keep my email addresses private" in
GitHub settings so later commits follow.

Unmerged branches move onto the new root with `git rebase --onto main <old-main> <branch>`;
the old history is still reachable from `archive/pre-public-history` if a diff is needed.
Never push `archive/*` to the public remote.
