# Auxiliary services: live acceptance and blocked dependencies

Date: 2026-10-19
Issue: #33; ADR-0041 and ADR-0046
Lab material: **2026-10-19 — Observability and search service acceptance**

## Completed

The v0.7.6 stable installation's SQLite observability sink was enabled after
backing up its configuration and checking there were no active runs. A later
root-authenticated status read returned HTTP 200: enabled, sink `sqlite`, no
last error, zero pending batches, and non-null received and committed cursors
for all 13 tables. The open spool held 2,283 bytes at that observation. This
proves live collection and commit activity, not a full source/sink count audit
or crash-injection acceptance. Payload policy remained its existing `full`
default; no broader derived-payload decision is inferred.

A separate isolated Gateway ledger and SQLite sink exercised the actual
configured embedding service through the production retrospective. Three
synthetic ordinary runs (two succeeded, one failed) produced three persisted
vectors and one matched failed run. The succeeded vectors had 1,024 dimensions.
One `retrieval_calls` row recorded corpus `retrospective`, purpose `index`,
three inputs, 41 reported input tokens and outcome `ok`. A second step made
no additional embedding request. There were zero generative model requests.
The test passed in 2.35 seconds including startup; its body took 557 ms.
Neither the stable ledger nor real chat contents were used as fixture data.
This is a runtime-path check, not retrieval quality or strategy adoption.

## Blocked or incomplete

The release's pinned Grafana image failed to pull at the configured Docker
mirror's CDN TLS handshake on two attempts. No daemon setting, trust policy,
version pin or digest was weakened to bypass the failure. The Gateway's
Grafana upstream was left unset, so Analytics is not advertised as a working
integration. The collector remains enabled independently. Grafana health,
authenticated rendering, plugin queries and the conditional image T2 remain
unverified. Unrelated existing services and Docker caches were preserved.

The release's SearXNG image built and its stable service became healthy.
Real queries returned HTTP 200 with zero results; the default engine set
reported upstream timeouts. Direct host checks to two search sites returned
HTTP 200, but targeted SearXNG engine requests still returned no usable
results. No host proxy variables were configured; missing proxy configuration
is not established as the cause. The workspace search switch remains off by
default. A healthy process is not evidence of a usable public search path.

No live image-generation service or paid model profile was configured. No
historical shared Docker resources were deleted. Account-based provider
acceptance and native-speaker copy review remain separate owner-assisted work.

The private lab retains the synthetic embedding test, log and usage receipt,
and a sanitized stable collector status receipt. This record deliberately
contains no private service addresses, credentials or chat bodies.
