# v0.3.1 release validation checkpoint — 2026-10-06

**Latest update, 2026-10-06:** connectivity recovered. The original full T2
passed (29 files, 93 tests, one skipped). Remote browser sign-in/task checks and
all three frozen real-model functional scenarios subsequently passed. v0.3.1
remains installed but not activated; the explicit transport/Owner choice is
pending. The initial interruption checkpoint below is retained as history;
the continuation evidence is at the end. Raw evidence remains outside Git.

Owner request: update the Testbox internal-trial deployment from the merged
`main` branch and run one functional scenario round. This checkpoint is partial:
v0.3.1 is installed, **not activated**, and no real-model scenario has started.
The last observed active version is v0.3.0. SSH to 10.88.40.132 subsequently
timed out, so present server state and the final full T2 outcome are unknown.

## Source and release gates

Fetched main `3e873af0f4bd54ba1e43644a4bf328ae00e9dd02` includes merged PRs #4,
#7 and #6 (tenant/auth proposal, M4 acceptance preparation, persistent sign-in).
Its CI [37353183824](https://github.com/TolemyW/deskmates/actions/runs/37353183824)
failed documentation consistency: ADR-0006 decision 10 had no recognized complete
Verification row. Adding the amendment's Verification heading made the existing
row discoverable; no authentication implementation changed.

Annotated release v0.3.1 points to
`eb235c974912221108c56b7607a7deb1ccc2de10`. Its source archive SHA-256 is
`19fdb96abc4082f2ee2e06d5d371e6d758f7a117e9d03b1440c61e9b4121f773`.
The [release workflow](https://github.com/TolemyW/deskmates/actions/runs/37353828975)
passed typecheck, lint, docs consistency, 283 root test files / 2992 tests,
41 Web test files / 282 tests, Web typecheck/build, image smoke and publication.
The root and Web counts overlap and must not be summed. Local typecheck/lint,
documentation consistency and 33 documentation-tool tests also passed.

Testbox installation used the documented `LOCAL_BASE=1` fallback. Exact IDs:

| Image | Installed ID |
| --- | --- |
| Base `amd64-afd228b644f2` | `sha256:bffdc561d23361c6d199f62981b7543cc55f476bc28ef505da16207f700a61f5` |
| Workspace `amd64-508aff2f0d96` | `sha256:e6009f0402a8029c6343f4ee1f1be6cdb5b9d8814a537a73fb4f13b40f3cddf4` |
| Egress `amd64-7d91517883a7` | `sha256:37d262a80778dcdb693179d20da247b09c97ad1ca48a504d74096de865e2f9b6` |

The locally built base differs from the workflow base
`sha256:18552649e12b2c6bc5d8fc88830f2b3c443627945300f572eeacac4bf6036288`.
Target-host T2 smoke used the installed workspace ID, no model environment and
two workers: **10 files / 29 tests passed**, 80.09 seconds. Smoke copies are
`.release/t2-smoke.json` and `.release/t2-smoke.log` in the installed release.
A subsequent full T2 invocation used the same image and two workers under the
heavy-test lock. Its final `.release/t2.json`/log must be inspected after reconnect;
the captured local full log contains only the start header. Neither success nor
failure is inferred from the missing SSH output.

## Frozen functional round and browser diagnostics

The isolated test root is
`/home/owner/agent_workspace/deskmates-reusable-release-20261006-19e7ec04`.
The source/harness transfer has an explicit inventory and hashes (1716 regular
source files and six initial harness files, plus source symlink metadata), with
no credentials, `.git` history or `node_modules` transfer. Fresh npm installation,
typecheck and Web build passed there. No stable database or workspace is used by
the scenario fixtures. The plan is in
`spikes/release-validation-20261006/README.md`:

| Case | Evidence at interruption |
| --- | --- |
| Built-UI browser sign-in | Local diagnostic: 11 functional checks passed, plus setup. Remote fixture did not reach assertions. |
| Portable direct chat / two-bot delegation | Prepared from unchanged `examples/scenarios/team-smoke.json`; not submitted. |
| Shared-browser operations brief | Unchanged M3 group-workspace acceptance test prepared; not invoked. |
| Signed-in task management | Local diagnostic: 8 checks passed. Remote fixture did not reach assertions. |

Both initial remote browser fixtures exited during startup because host Node
22.22.0 built the SQLite addon with ABI 127, whereas image Node 24.13.0 requires
ABI 137. This is a fixture-runtime mismatch, not a product assertion failure.
Their logs/exits remain in the isolated root. A copied host Node 22 executable
and fresh v2 drivers were prepared with hashes, but never executed before the
connection interruption. No product change was made for the mismatch.

Local diagnostics used Playwright 1.58.2 with cached Chrome **153.0.8010.12**,
real listeners, built UI and independent SQLite, synthetic accounts and fake
sandbox providers. This browser is not the pinned release browser, so these
checks do not replace Testbox acceptance. The unchanged sign-in spike verified
locked setup, password rejection, secure cookie/storage/SSE behavior, reload,
restart, cross-site refusal and two-device sign-out (observed revocation 67 ms).
The task driver verified create, deliver without auto-accept, signed-in principal
attribution, accepted read-only reload, explicit reopen, conflict draft retention,
explicit conflict reload and zero agent runs. The artifact field is only a fixture
reference; no artifact bytes are claimed to exist.

The first five local task-driver variants failed on locators or a transient
notice wait. All remain in `/tmp/deskmates-release-20261006`, with their logs and
failure screenshots. Correcting the driver (New task is a link, persistent state
wait, labels include their select/textarea values) yielded all eight passing
checks in `local-task-browser-v6`. Assertions were not removed, and product code
was not changed. Final harness TypeScript and shell syntax checks passed.
Machine-readable local browser receipts and evidence hashes are retained in
`spikes/release-validation-20261006/receipts/`.

## Pending deployment and continuation

No v0.3.1 activation, stable `.env` change, Owner bootstrap or upgrade backup has
been performed. Thus no new-release database migration was deliberately run on
the stable database. Before activation, resolve the explicit owner transport
choice in [the stable runbook](../runbooks/stable-release.md#before-deploying-the-first-release-with-browser-sign-in-adr-0022-p1):
HTTPS plus allowed origin, or explicitly accepted `insecure-dev` cookies over
the existing LAN HTTP address. The runbook says: "Which one is the owner's
decision." First-Owner setup must also be arranged without passwords in chat or
arguments. Audit existing channel adapters for header-auth SSE compatibility.

Reconnect first; read the original full-T2 receipt and lock state rather than
automatically repeating tests. Audit only exact recorded owned resources. Preserve
the initial harness archive and transfer the corrected browser driver as a new
hashed material; the locally prepared v3 materials have not been transferred.
Run fresh remote browser fixtures with the Node 22 shim and pinned image. Back up
both the stable SQLite database and the exact integration runtime's `/app/data`,
preserve `GATEWAY_SECRETS_KEY`, activate and verify the release, and keep rollback
as database restore plus v0.3.0.

Then execute the frozen isolated model round once, with its physical/observation
caps and no task retry or automatic external-action approval. Retain actual
artifact checks, every logical/physical run and input/output/cache usage; missing
usage is unknown. This round has launched **no real model calls**, so it has no
model-token result. It makes no statistical, memory-efficacy, live Drive/OAuth,
paid stock research, WhatsApp delivery or full M4 acceptance claim. Previously
retained screenshot-ledger attribution and other milestone failures remain open.

## Continuation after reconnect — 2026-10-06

The original full T2 finished at 02:30:18 Asia/Taipei, exit 0, 29 files /
93 passed / one skipped, 373.26 seconds. This was read from its original receipt
and log after reconnect, not obtained by a repeat invocation. Stable `current`
still points to v0.3.0.

The final harness inventory and new v3 driver materials were verified on Testbox.
Optional host-side browser type dependency installation stalled and was stopped;
local harness typechecking had passed. The fixtures used the image's preinstalled
Playwright/browser with the host Node 22 shim. Both fresh v3 fixtures exited 0:
sign-in 11 functional checks plus setup; task management eight checks. Initial
startup failures and local driver failures remain retained. Test-container-created
evidence ownership was corrected only for the exact isolated output files.

The model round was atomically reserved at 13:28:52 Asia/Taipei and launched once.
Stable activation was not a prerequisite for these independently isolated
fixtures. Unchanged portable single-bot and delegation tasks both passed; the
unchanged shared-browser brief case passed in 112.367 seconds (125.76 seconds
including suite setup/teardown). No task was resubmitted or approval auto-decided.
The actual workspace file was read before teardown and retained in the report;
all three facts matched the fixture: 23 open tickets, revenue 128450 and zhang's
open ticket IDs 1012, 1024, 1036. The ticket analyst wrote/answered the brief and
the lead did not participate. Functional correctness does not establish stable
role adherence or hour-scale long-task reliability.

Seven logical/physical runs, each attempt 1, forwarded 32 `messages` requests to
GLM-5.3. SDK ledger totals are input 144707, output 4820, cache-read 640000 and
normalized cache-create 0. All request input/output usage is known; two requests
omit cache-read and all 32 omit cache-create in the proxy receipt. Those missing
fields remain unknown rather than being inferred as zero from SDK normalization.
Pricing is unknown. The group ledger backup is saved and both test databases pass
SQLite quick-check. The per-run/request breakdown is in the external
`round-summary.json`.

Exact-ID audit covers 74 containers, 34 workspace networks and 102 volumes from
the recorded test ownership journals and helper CID files: none remain and no
inspection outcome is unknown. No prefix cleanup or daemon prune was performed.
The stable deployment and integration runtime were not changed.

Raw logs, SQLite ledgers, screenshots, inventories, captured brief and the compact
`round-summary.json` / `final-owned-resource-audit.json` remain in the isolated
remote root named above. Local reviewed copies are in
`/tmp/deskmates-release-20261006`, outside Git. This is one functional observation,
not statistical, memory, visual-model, natural-soak or full M4 acceptance.
As of 2026-10-06 this continuation had not been committed; it is committed
together with the v0.3.2 update record of 2026-10-08.
