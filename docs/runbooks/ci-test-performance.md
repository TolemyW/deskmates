# CI test performance

The `gate` job keeps one dependency installation, one typecheck, the existing
affected test selection, and per-file isolation. Its test steps use
`node scripts/ci/test-metrics.mjs`, which calls the existing `npm test` script with
both worker bounds fixed at two. Normal local `npm test` is unchanged.

The wrapper prints `CI_TEST_CONFIG` before testing and `CI_TEST_METRICS` afterward,
and appends a table to the Actions job summary. It records available/logical CPUs,
system memory, worker bounds, test counts, wall seconds, and GNU time maximum RSS.
Additional arguments (including `--changed`) are passed as argv, without a shell.
The original test exit status is preserved; unavailable measurements are unknown.

`observedConcurrentTestFiles` comes from overlapping Vitest JSON file-test
intervals. It measures executed test overlap, excluding collection/startup; it is
not a worker-process census. GNU time's maximum RSS is not the sum of concurrent
process memory, nor the whole job's memory peak. Both distinctions also appear in
the job summary. Diagnostics remain in the run log; JSON/resource files live in
the runner's temporary directory for that job.

The comparison baseline is PR #84, run `40276885004`, attempt 2, source `270a1ce`:
903 files / 8,447 tests passed. Total elapsed was 1,429 seconds, with 1,299 seconds
in the full-test step (Vitest wall 1,297.72 seconds). Emitted file test intervals
had maximum overlap one. That is evidence of test serialization, not direct CPU
or process instrumentation. Subsequent runs should compare elapsed time and
coverage on the same runner class; a local machine is not a matched speed trial.

## Affected selection

`scripts/ci/test-scope.mjs` classifies the pinned PR base diff before build steps.
The Actions summary and `CI_TEST_SCOPE` log record the chosen scope and reason:

A change runs what it touches; the full suite is the exception (owner decision
2026-10-27, after a Dockerfile-only change ran all 909 test files for 20 minutes):

- Prose proposals, runbooks, release notes, ADRs and package documentation run
  lint, documentation consistency, import-related tests and documentation
  guards. They skip production typecheck and Web build. The bundled
  `docs/guide/` is UI input, so it retains the Web tests/build.
- Source and test edits, including `packages/contracts` and `packages/testkit`,
  use Vitest `--changed`: the root Vitest config resolves workspace packages to
  their sources, so the import graph reaches every consumer. Backend-only
  changes skip the unrelated Web build; Web/UI inputs retain it.
- Every changed path also runs the tests that name it or its directory
  (`git grep` over unit/integration tests, `findReaders`), which covers files
  read as text: Dockerfiles, `.env.example`, fixtures, generated documentation.
- Owners cover what no test names by path: migrations, route policies, locales,
  snapshots, a package's `package.json` and other non-module package inputs run
  their package's tests; `images/<name>/` runs that directory's tests plus
  `packages/sandbox-docker/` and `scripts/` for the workspace and egress images;
  `observability/` runs the dashboard packages; shell scripts and workflows run
  `scripts/`; `docs/generated/` runs its generator's test.
- Unknown paths and empty diffs run the guards and readers above, never the full
  suite. Production typecheck runs only when code or a package manifest changed.
- The full suite runs only for the root toolchain every test goes through
  (`package.json`, `package-lock.json`, `tsconfig.base.json`, `vitest.config.*`)
  and for manual/reusable invocations.

Git diff includes both sides of renames; removing a root toolchain file retains
its fallback. Invalid bases or failed diffs fail the gate. A zero-related-test
result is acceptable only on the scoped import-graph step: explicit guards still
run. This is impact selection, not a claim that Vitest tracks arbitrary
filesystem reads: a new kind of input that is read by building its path, and
that no test names, needs an owner entry in `test-scope.mjs`.

Thread pools, fixture lifecycle, isolation and job sharding retain their existing
behavior. Local pre-ready validation still follows AGENTS.md.
