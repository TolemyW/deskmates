# FRAMES-derived frozen public-corpus browser preflight

Date: 2026-09-26 (Asia/Taipei). This is a **standalone no-model browser-fixture
check**, not a Deskmates run, a human citation review, or a score on FRAMES's
live-web protocol. The underlying exact rows, answer controls and source
integrity are in [the private FRAMES feasibility receipt](frames-feasibility-2026-09-25.md).

The new adapter lives only in `spikes/reusable-tasks/frames/public-corpus/`.
`export.py` read five pinned UTF-8 Wikipedia revision snapshots from private
`/home/owner/agent_workspace/deskmates-reusable-evals/frames-20260925/private/prepared/snapshots/`.
It checked each title, revision ID, old-revision URL, CC BY-SA 4.0 attribution,
revision time and exact wikitext SHA-256. It exported escaped source wikitext
and attribution to the **separate**
`/home/owner/agent_workspace/deskmates-reusable-evals/frames-20260925/public-corpus-adapter-20260926/public/`.
That directory contains five HTML pages and a search index of those public
pages only. It contains no dataset TSV, row JSON, Answer key, source-to-case
mapping, evaluator manifest, citation rule or grader control. A bounded marker
scan found none of `row-13`, `row-2`, `test.tsv`, `"Answer"` or
`snapshot-receipt` in the exported files. Natural source facts remain in the
articles by design.

| Public article | Revision | Exported HTML SHA-256 |
| --- | ---: | --- |
| Punxsutawney Phil | 1375565264 | `e2f0a9c8745cd542e99f909f86ea897a9aa11abfa832c6d846dbe341701fc56b` |
| United States Capitol | 1375748217 | `aa7dd67c1799b617a4de08230dfef39f61fe7a17b71db384b02d4c23ccdb0d5c` |
| Barbara Kingsolver | 1371367589 | `04d46c4ddbee6d99a520d44190bd1a73a0af5acda2b322302b3ad6d6bc3e6e97` |
| The Poisonwood Bible | 1356679475 | `75c4d7ee37fdaecaf2279e1c0f341ad605d66a148714699e7c344ba82d28b853` |
| Belgian Congo | 1375469706 | `5f617398284275d617b1decc1b12529dcff9bee5b8c48c2a85e0fde05fbcaab1` |

`server.py` served only `/`, `/search`, `/page/<pinned slug>` and `/healthz`;
it did not expose its filesystem as a static directory. A Docker server
container mounted **only** the public export and the server script read-only.
The Playwright browser container mounted only its preflight script and a
private trace output directory. Both used existing pinned older Deskmates
workspace image ID
`sha256:48a13e7c64b65825afdc22abffa784f380a7bf4ccc38c2212a222f92f6600fc9`
on a newly created internal Docker network (`Internal=true`), with no published
ports. No private row/snapshot/grader directory was mounted into either
container. The network ID was
`7424b91f2fa94b49c7c025f7cf98cd9323a2821eaa2dfd245d3e193888dfd3f9`;
server container ID was
`8e586d3fe00fc525370dcebcaa2fc0c74ac36780cd0c19f17c22c8bc56f1b859`.
Both the server and internal network were removed after the check; immutable
logs and trace remain private.

The Chromium preflight ran from 2026-09-25T16:30:00Z to 16:30:01Z, exit 0.
It searched each of the five article titles through the visible form, opened
the result, checked title, exact revision URL and CC BY-SA attribution, and
asserted each served HTML SHA-256 equaled the export receipt above. Seven
attempts to fetch private-style routes (`row` files, TSV, snapshot receipt,
manifest, search index and a traversal route) all returned 404. The browser
request listener saw **zero** external page requests. The run was on a Docker
internal network, so there was no external network path even if a page had
tried one. Evidence: `browser.stdout.log` SHA-256
`b36cba82cdeb97d8dc65d81a0d1e00fc512a0925aa1089a8c1acc1df731f1d39`,
Playwright trace SHA-256
`82d26714dc83388d4f1d5165235126c9e324d4854570363707c74eac949c255b`,
`export.stdout.json` SHA-256
`989ac03e32f58fdfcc5b05ddd4263f5ea0222304e305c794b4677e2a7d635c58`,
and full private `evidence-sha256.txt` in the adapter root. Script SHA-256:
`export.py` `33681c2933243bb4cc8b3d383d053fba7c625949a0191b90b0fa4bea1c70208c`,
`server.py` `a0e9d0de2d0a0dbad2a4f92ca094b055289b04960e11ef06414b4c64c27a5fa2`,
`browser-preflight.cjs`
`142b12fbaabdc43aed7f90572adcc8a928bf5e38549799eb60c42ba80d220e5c`.

This deliberately tiny five-page, wikitext-only corpus makes search and
multi-hop reading technically repeatable; it does not approximate open-web
retrieval difficulty or guarantee that citations support a response. A future
Deskmates workspace must be wired to the internal corpus host with denied live
web egress, preserve its own run/browser trace, and keep private grading files
outside the workspace. Two independent human citation reviewers still need
calibration on supporting and misleading examples. FRAMES-2's ambiguous
“same state as the US capitol” premise remains unresolved. No model budget or
actual agent result is implied by this fixture check.
