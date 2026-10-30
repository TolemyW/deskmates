# Placing files in a workspace

How an operator puts files into a workspace's `/work` so that its bots can use them.

Status: written 2026-10-17 from the finding of the long-horizon campaign of 2026-10-11 (issue #3,
section B). The `docker cp` commands below have not yet been rehearsed on a live host; record
the first rehearsal here.

## Why ownership matters

Every process in a workspace container runs as root, and the container has no Linux capabilities
(`CapDrop: ["ALL"]`, `packages/sandbox-docker/README.md`). Root without `CAP_DAC_OVERRIDE` cannot
write a file owned by another uid, and without `CAP_CHOWN` it cannot take ownership of it. A file
in `/work` that is not owned by uid 0 is therefore read-only to every bot, and nothing inside the
container can fix that. The campaign hit this with files copied in by `docker cp`; it is not a
`tty_session` defect (correction to issue #54 item 7).

Everything the platform itself writes (uploads, memory and SOUL edits, renames) goes through an
exec as the container's root user and is root-owned; `docker-provider.test.ts` and
`workspace-image-user.test.ts` keep it that way.

## Preferred: upload through the product

Upload through Files in the operator UI. The file lands in `/work/uploads`, owned by root. Uploads
are read-only to bots in every mode (ADR-0038 decision 3): a bot copies what it needs into its own
directory, `/work/bots/<bot>`, and works on the copy.

## From the host with `docker cp`

`docker cp` keeps the uid and gid of the entries it is given, so files copied from a host
directory arrive owned by their host owner. Stream a tar whose entries are owned by uid 0 instead.
The workspace container is `deskmates-ws-<workspace id>`; the destination directory must exist.

```
# GNU tar
tar --numeric-owner --owner=0 --group=0 -C <source dir> -cf - . \
  | docker cp - deskmates-ws-<workspace id>:/work/<destination dir>
# bsdtar (macOS)
tar --uid 0 --gid 0 -C <source dir> -cf - . \
  | docker cp - deskmates-ws-<workspace id>:/work/<destination dir>
```

Check that nothing is owned by another uid; the command prints nothing when the copy is right:

```
docker exec deskmates-ws-<workspace id> find /work/<destination dir> ! -uid 0
```

A `chown` run through `docker exec` fails inside the container (no `CAP_CHOWN`). To repair files
already copied with the wrong owner, copy them again with the tar form above: the daemon extracts
the archive outside the container's capability set and overwrites them as uid 0.

## Where to put them

- A file one bot works on: that bot's directory, `/work/bots/<bot>`. Its teammates can read it;
  in per-bot mode only that bot writes there (ADR-0038).
- A file the whole team edits: a team area under `/work` outside `bots/` and `uploads/`
  (ADR-0038 decision 6).
- Never a credential: everything in `/work` is visible to every bot in the workspace (ADR-0004).
