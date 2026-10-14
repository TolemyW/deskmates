# M2 live-model foundation probe

This runs the real SDK through an isolated Gateway and a freshly built workspace
container. It tests chief/expert collaboration, group ordering/silence, concurrent explicit
mentions and the real `message_bot` tool twice each by default (`--repetitions 5` runs five pairs per scenario when used for both variants). It does not claim browser-tab concurrency or
full M2 acceptance. Test-specific SOUL files are fixtures, not production strategy
changes or evidence of a better prompt.

Build from the integration worktree (tag per
`docs/runbooks/image-tags-and-artifact-naming.md`), then pass the image ID, never the tag:

```sh
npm run image:workspace
node spikes/m2-live/run.mjs --env /path/to/main-checkout/.env \
  --image "$(docker image inspect --format '{{.Id}}' deskmates/workspace:<tag>)"
```

Use `--snapshot-mode inline-v2` to confirm the messaging gates on that opt-in
browser configuration. The default remains `explicit-v1`; the selected mode is
recorded in the manifest and applied before any test run is scheduled.

Only the four required model variables are read from the supplied file; exported
values win. Credentials are not copied into the worktree or printed. A missing
configuration or daemon fails instead of silently skipping the tests. The suite
uses ephemeral ports, its own database and volumes, and cleans up only its own
container/volumes. The existing application and `:dev` image are left alone.

`work-*/manifest.json` identifies the source, image and model; `results.json` holds
case results, latency, per-run usage, transcripts and ledger events. These runtime
artifacts are ignored by Git. Model costs stay unpriced unless a price table is
configured; token counts are the direct usage evidence. Each case retains its report, including failures. The suite continues through the
fixed matrix and exits nonzero if any case failed; it does not retry until green.
Run `node spikes/m2-live/summarize.mjs <output-directory>` for token and duplicate-message totals.


For a routing-context comparison, use the same Gateway revision (including final-reply
idempotency), model, fixture and repetitions for both variants. The older workspace image
renders the legacy trigger; its stdin schema drops the additive routing fields. The candidate
image renders routing context v1. Record both immutable image IDs. `threadContextVersion`
in the Gateway run configuration describes the offered payload; the legacy sidecar image
ignores that payload extension, so use the image identity as well when attributing baseline
results. The complete statistical comparator described in `evals/README.md` is not yet
implemented. These focused probes are regression evidence, not a general strategy verdict.

After both complete matrices finish, run:

```sh
node spikes/m2-live/compare.mjs <baseline-directory> <candidate-directory>
```

This checks the model, fixture hash, Gateway/contracts source trees and repetition count match,
rejects incomplete/duplicated matrices, and writes `comparison.json` in the candidate
directory. It reports paired outcomes, usage, dedup ledger counts and same-run duplicate
rows. It deliberately emits an inconclusive strategy verdict; it is not a substitute
for duration-bucket confidence intervals or the planned global comparator.
