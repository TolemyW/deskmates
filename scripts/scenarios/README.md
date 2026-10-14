# Portable test scenarios (v1)

Create repeatable test workspaces through the authenticated operator API. This
is a CLI prototype, not a full workspace backup or a deployment tool. It does
not install a Gateway, build an image or modify the stable deployment.

Run from a repository checkout with its Node 22+ dependencies installed:

```sh
npm run scenario -- validate examples/scenarios/team-smoke.json
npm run scenario -- help
```

The example contains a one-bot chat and a two-bot delegation task with bounded
waits and reply markers. It inherits the target Gateway's model names and sets
adaptive thinking/high effort. The prompts are fixtures, not a measured general
strategy. No real-model acceptance result is implied by the example.

## Import and run on Testbox

Use a separate test Gateway/database/container namespace in an authorized
`/home/owner/agent_workspace/deskmates-reusable-*` campaign directory. Do not point
this tool at the stable instance. Pin the source commit and workspace image in
that deployment. Configure its model endpoint and credentials on the host.

Set `RUN_TIMEOUT_SECONDS=180` and `DESKMATES_MAX_TURNS=8` on that **test Gateway**
before starting it. Task `timeoutSeconds` bounds the CLI's polling loop only;
it does not cancel a running model request. Individual API requests have a
15-second timeout, so a polling deadline can be exceeded by requests in flight.
On timeout or approval blocking, inspect the retained workspace. The CLI never
approves actions, deletes resources, or retries a task POST.

```sh
# Set these in a local environment file or shell, not the scenario JSON.
export SCENARIO_GATEWAY_URL=http://127.0.0.1:4301
# SCENARIO_OPERATOR_TOKEN must contain this test Gateway's operator token.

npm run scenario -- import examples/scenarios/team-smoke.json --receipt trial-01.import.json
# Import sends no task messages and disables all cron entries.
npm run scenario -- run examples/scenarios/team-smoke.json --receipt trial-01.import.json --out trial-01.results.json
```

Use the real test operator port instead of the example port. A remote API can
also be reached through an SSH tunnel; importing does not require copying the
local `.env`. The CLI does not load `.env` automatically.

Each repetition imports a fresh workspace using a new receipt filename. Bot
names remain unchanged so SOUL mentions work; database IDs are regenerated.
Thread member order is preserved. Tasks run serially; a failed, blocked, timed
out or unknown task stops the remaining tasks. An oracle is a substring in a
new bot reply, optionally restricted to one author. All observed runs must also
end successfully or silently. A task without an oracle is
`completed-unchecked`, never `passed`.

The receipt is reserved before writes and records created IDs after each API
response. Execution is reserved durably before the first task POST. Reusing a
receipt is refused even if a request timed out, because it may have succeeded.
A `.lock` file prevents concurrent use; a process crash can leave it behind.
Inspect the receipt and Gateway before removing a stale lock. To repeat a test,
import anew; do not reset the receipt's execution field.

Results include Gateway public configuration/release, task messages, run IDs,
per-run effective configuration, events and usage rows. Empty usage is `null`
(unknown), not zero. This is an API evidence snapshot, not a database backup;
retain the isolated Gateway's SQLite database and pinned image separately.
Files are created with mode 0600; results can contain task text and tool output.

## Export an existing configuration

```sh
npm run scenario -- export ws_REPLACE_ME --out my-team.json
# Edit my-team.json to add tasks, then validate and import it elsewhere.
npm run scenario -- validate my-team.json
```

Export includes workspace name/provider/egress/login probe, Bot name/role/model
overrides/reasoning/SOUL/manual MEMORY/message allowlist/connector names/cron,
and chat titles/members. Only Docker workspaces are supported. Thread keys are
generated; exported tasks are empty because arbitrary chat history is not a
test specification. Export is not an atomic snapshot: export a quiescent
configuration. Legacy SOUL/MEMORY first-import may require its source workspace
to be running. Fresh imports can install canonical files without starting it.

The package never includes API credentials, webhook tokens or browser cookies
from registry responses. Freeform SOUL, manual notes, prompts and probe URLs can
still contain secrets supplied by an operator; review them before sharing.

Intentionally outside v1: learned-memory versions/provenance, SDK sessions,
historical runs/messages, browser/filesystem state, knowledge documents,
approval rules, integration grants, group-owner state and non-default thread
turn budgets. Global model endpoints, prices, timezone, routing mode and run
limits stay deployment configuration. No per-task run-limit API is invented.
Cron definitions are retained in the package but always imported disabled;
there is no enable-schedules command yet. Each import starts with fresh learned
memory, but subsequent tasks in that same workspace may learn from earlier ones.

## Connector bindings

Scenario Bots refer to connector names. For each referenced name, supply a
local bindings JSON file; only environment-variable names go in it:

```json
{
  "connectors": {
    "database": {
      "urlEnv": "TEST_DATABASE_CONNECTOR_URL",
      "credentialEnv": "TEST_DATABASE_CONNECTOR_TOKEN",
      "kind": "postgres"
    }
  }
}
```

```sh
npm run scenario -- import my-team.json --bindings testbox.bindings.json --receipt trial-02.import.json
```

The URL is the **connector service HTTP endpoint**, not a database DSN. The
connector service must already be deployed. Its local credential and URL are
sent to the target Gateway registration endpoint, never stored in the scenario
or import receipt. Missing bindings fail before workspace creation. Use the
connector kind appropriate for that service; omit it for the Gateway default.

## Validation

```sh
node_modules/.bin/tsc -p scripts/scenarios/tsconfig.json
node_modules/.bin/vitest run scripts/scenarios --maxWorkers=1
```

Tests cover strict schemas, import/export round trips, canonical files, ordered
membership, disabled schedules, missing bindings, partial failure journals,
one-shot execution, unknown POST outcomes, approval blocking, timeouts and
reply oracles. A separate round-trip test uses real Fastify operator routes via
in-process injection with in-memory SQLite and a fake provider. No listening
server, Docker, real browser or model is used by these tests.

## Offline equity artifact audit

The scenario runner's `passed` status is a **reply-marker/run-state result**,
not proof that files exist or that research claims are correct. The dated
`us-stocks.json` fixture from a captured release-validation run can be checked
separately with an explicit captured snapshot:

```json
{
  "files": {
    "/work/fundamentals.md": "captured UTF-8 file contents",
    "/work/strategy-draft.json": "captured JSON text",
    "/work/risk-review.md": "captured UTF-8 file contents",
    "/work/investment-report.md": "captured UTF-8 file contents",
    "/work/strategy.json": "captured JSON text"
  },
  "expectedSourceUrls": ["exact official URLs from the dated source pack"]
}
```

These are placeholders, not a passing fixture. Capture actual file contents;
do not substitute a completion message. `expectedSourceUrls` is optional but
recommended to detect changed/missing source-pack links. Source URLs may be
strings or objects with a `url` property in the strategy output.

```sh
node --import tsx scripts/scenarios/audit-equity-artifacts.ts captured-snapshot.json
```

This command only reads the supplied JSON (maximum 8 MiB); it never visits a
URL, contacts a Gateway, starts a model, or changes workspace files. Exit zero
means `structure-valid`, not scenario acceptance. It checks exact required
paths, nonempty content, object JSON, the fixed 2026-10-01 date, three-ticker
universe, finite allocations, sum within 1e-9, caps/cash, leverage, not-run
backtest status, nonempty rule fields and official-host source URLs. It returns
SHA-256 hashes of the inspected files and explicit unchecked categories.

Independent financial fact checks, substantive rule quality, agreement between
prose and JSON, artifact freshness/authorship and write-before-marker ordering
still require their own evidence. The original risk role permits a clearly
labelled checklist; this audit does not silently upgrade that contract to a
review of the final allocation. Draft and final allocations may legitimately
differ. A source URL passing the structural check is not proof of retrieval,
an official claim's accuracy or the correct fiscal period. Keep the snapshot
private if the captured files contain private text.
