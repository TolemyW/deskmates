# Operator UI acceptance and cached-container presence repair

Date: 2026-10-19
Tracking: issue #33, bot editing/diary, run audit, container state, Files links and takeover
Lab material: **2026-10-19 — Isolated Gateway operator UI and owned-container acceptance**

## Environment and limits

These are real Chromium journeys through the production Web app and a real authenticated
Gateway with an isolated in-memory SQLite database. Accounts, workspaces, messages, errors,
diary lines and rule values are synthetic. The sidecar and most sandbox operations use a
controlled provider; no SDK or model is called. The stable deployment and its data were not
modified. These results do not by themselves complete issue #33's **deployed** checks.

The Web app was frozen in an archive from `fb8975d` to exclude unrelated concurrent working-tree
edits. Its Web/UI/contracts tree equals the `94992a6` v0.7.6 baseline. Chromium was
`153.0.8010.12`, at 1440 × 1000. The final operator receipt has nine passing groups and no
uncaught browser errors. The controlled screen transport does not provide a real desktop;
takeover results below prove UI/lease/role behavior, not a noVNC visual task.

## Browser-to-Gateway results

| Journey | Observed result |
|---|---|
| Connector assignment | Edited two synthetic connector names in the Bot profile, saved through the real API and reloaded. SQLite and the reloaded inputs contained the exact values. No connector service or credential was configured. |
| Approval rule editing | Created a narrow synthetic rule through the UI, edited its website and argument pattern and saved. The persisted rule kept its original id and contained the updated matcher. |
| Editing while busy | Saved SOUL under a synthetically live run. The UI explicitly said it applies to the next work; the active run retained its frozen prior SOUL hash and the canonical Bot file gained the new text. |
| Diary audit | Opened the synthetic diary, confirmed deletion of one line and observed the other line remain. The real Gateway audit recorded actor, day/index, removed-line SHA-256, character count and resulting version/count; the audit contained no deleted plaintext. The diary filesystem command itself was simulated. |
| Failure filters and replay | The real API's composed workspace/status/failure-class/text query returned only the intended failure. Its drawer showed `model_unavailable`. The browser copied the exact replay-export command, and the actual exporter read the authenticated Gateway and produced one trace with the expected ledger events. |
| Mark/unmark | Marked a run wrong with a note, verified the stored mark, reloaded the drawer, unmarked it and verified absence through the API. |
| Files round trip | Clicked a chat attachment's **Show in Files**, then **Sent in chat** and returned to its message. Opening a file deep link into the other synthetic workspace switched context and its **Sent in chat** returned to that workspace's chat. |
| Close/Escape release | Took the workspace lease through the chat, closed the control dialog and verified release in the real lock store. Repeated with Escape. The hidden dialog left no held lease. |
| Takeover roles | A Guest had no Take over action and its direct API attempt was 403. A Member could take its own lease. An Owner handed back that Member's lease; the Member's open dialog closed. A Member had no Hand back action for the Owner's lease and its direct attempt was 403; the Owner then released it. |

The runs index and its filter UI were withdrawn by the owner in ADR-0042 amendment 1. Failure
filter acceptance therefore exercises the retained API and the drawer's classification, not
an intentionally removed screen. The replay is a developer-side exporter, as decision 5
specifies; the browser offers its command rather than writing into a repository.

## Confirmed container-state defect and repair

A separate fixture created a new, exact Docker container carrying a random test ownership
label, cached its handle in the real Gateway and recorded prior successful work. After an
explicit `docker rm` of only that id, the baseline API still returned `present`. The registry's
cached `peek` branch did not consult the provider. The red regression reproduced the missing
eviction and the swallowed inspection failure before the repair.

`SandboxProvider.isPresent` is an optional, read-only check of one exact cached handle. Docker
issues one inspect GET: only 404 means missing, a stopped container is still present, and
daemon/permission/HTTP/invalid-response/ownership failures remain errors. The Gateway evicts
only confirmed-missing cached handles and returns absence without calling attach. This changes
the cached branch only: the existing uncached attach path may restore an existing runtime.

The fixed Chromium fixture used real Docker containers and the production Docker inspector,
with synthetic create/sidecar completion around them. It verified:

1. The workspace page showed Present.
2. After stopping the exact container, the page still showed Present and Docker confirmed it
   remained stopped after the status read.
3. After removing that exact container, the page showed Removed and created nothing.
4. The chat explained that the next message recreates the computer. Sending a synthetic
   message created a different container id, received the fake sidecar's reply and restored
   Present on the workspace page.

Both exact test containers were removed after the final run; no volume, network or pre-existing
container was selected. This fixture does not exercise a complete workspace image and egress
proxy, or upgrade the stable host. Those deployment boundaries remain explicit in issue #33.

## Evidence

The private lab material includes the frozen Web-source archive, both runners, the original
failing cache receipt, final operator/container JSON receipts, replay trace, synthetic audit
records, per-request status log and screenshots. An explicit SHA-256 inventory accompanies it.
The final JSON and fixture hashes are recorded in that inventory, without credentials.

The product regression suites cover confirmed absence/cache eviction, present/stopped
preservation, inspection errors and retry, Docker 404 versus 403/5xx, transport errors,
malformed JSON and mismatched ownership. No architecture or UI behavior outside the cached
presence observation was changed.

The final targeted run passed 62 tests across the new presence suites and the existing Docker
provider suite. The existing registry and topology-revalidation suites also passed (18 tests).
The complete repository typecheck and Biome checks of the five changed product/test files passed.

Still unverified here: the stable-host account/diary/full-container journeys, real noVNC pixels,
the slow-model/stalled transitions, provider accounts, retention-owner acceptance and native
Chinese copy review. This record must not turn any of them into a pass.
