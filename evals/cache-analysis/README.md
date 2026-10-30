# Context and cache observations

Zero-token tools for ADR-0037 amendment 1 and ADR-0023 amendment 5. No model,
Docker, credentials or Gateway service is needed. Python 3's standard library
is sufficient for the SQLite report; Node uses the repository's existing TSX.

```sh
python3 evals/cache-analysis/report.py --db <gateway.sqlite> \
  --window 2026-10-16T00:00:00.000Z,2026-10-17T00:00:00.000Z \
  --window 2026-10-17T00:00:00.000Z,2026-10-18T00:00:00.000Z
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s evals/cache-analysis -p '*_test.py'
TSX_TSCONFIG_PATH=evals/tsconfig.json node --import tsx evals/cache-analysis/context-construction.ts
```

`report.py` uses SQLite `mode=ro` and `query_only=ON`. It outputs counts,
distributions and hashes, never prompt text, model names, workspace identities,
tool payloads or secrets. Time windows select request timestamps with
`start <= ts < end`. Agent requests, jobs and non-inference requests are
counted separately. A positive cache-read count is a reported request hit;
its share uses only requests that reported the field. A token-weighted share
uses only rows that report input, cache-read and cache-create tokens, and
remains unknown when that denominator is unavailable.

`agentFirstObservedRequestPerAttempt` means first within the selected window,
not necessarily the first turn of an attempt that started earlier. Context
full samples and pre-query spans belong to the selected agent attempts; a
sample may precede the window when the attempt crosses its boundary. The
pre-query span includes all work between `sidecar_started` and `query_started`,
not just context construction. Configuration hashes use `CONFIG_KEYS` listed
in the source and distinguish the relevant recorded knobs; they are not a
source-commit hash or proof that tasks are paired. Served-model identifiers
are hashed separately.

`context-construction.ts` calls the production context builder on a fixed,
synthetic, in-memory fixture. It excludes process/module/SDK startup, filesystem
I/O, networking and upstream caching. Its invalidation checks also use actual
controlled inputs: edit memory/diary, then edit SOUL. It is a CPU measurement,
not a model-quality verdict or an implementation of a cache.

The 2026-10-19 result is `results-2026-10-19.json`; interpretation and pending
gates are in `docs/design/context-cache-investigation-2026-10-19.md`.
