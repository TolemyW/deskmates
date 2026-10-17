# ADR-0039: Multi-upstream model registry

Date: 2026-10-14
Status: Accepted for decisions 1-6 (owner-decided 2026-10-14, OWNER-DECISIONS items 9 and 15: credentials installation-level in Deskmates `.env`, no automatic fallback, local GPU-host models priced as known zero, `qwen3.8-27b` as `CHEAP_MODEL`). Decisions 7 and 8 are proposed. Implements phase P1 of `docs/design/multimodal-models-2026-10-14.md` for the chat operation only; specialist operations (OCR, ASR, generation) are later phases and are not decided here. No real upstream was contacted; tests use fake upstreams.

## Context

Until this ADR the Gateway had one model upstream: `MODEL_BASE_URL` with its Bearer `MODEL_AUTH_TOKEN` (`config/model.ts`). The model proxy (`model-proxy/model-proxy.ts`, ADR-0002 item 4) checked a run's request against its frozen models (ADR-0023 decision 1), admitted it against the workspace budget (ADR-0032 decision 5), swapped the run token for the upstream token and forwarded it to that one URL. Every model id therefore had to be served by the same endpoint.

The owner set up local vLLM servers on the GPU host (`10.20.50.16`, reachable from the stable host, no authentication) that speak the Anthropic `/v1/messages` protocol: port 8003 `qwen3.5-9b`, 8004 `qwen3.8-27b` (intended `CHEAP_MODEL`), 8005 `qwen3.5-9b-vl` (vision). They are separate endpoints, so they cannot sit behind the existing single upstream, and they cost nothing per token. The owner approved a multi-upstream model registry (#115 P1) on 2026-10-14 and ruled that credentials stay installation-level in `.env`, that there is no automatic fallback across destinations, and that local models are priced as a known zero.

## Decision

1. **The registry is installation configuration in `.env`, never in the database or a route.** `MODEL_BASE_URL` and `MODEL_AUTH_TOKEN` keep their meaning and become the upstream with id `default`, which serves every model id no other upstream lists (today's behaviour, so existing deployments change nothing). `MODEL_UPSTREAMS` adds upstreams as a JSON array of `{id, baseUrl, authToken?, models, protocol}`: `id` is a lowercase slug (`[a-z0-9][a-z0-9-]{0,31}`), unique, and not `default`; `baseUrl` is an `http(s)` URL (trailing slashes dropped); `models` is a non-empty list of exact model ids, and a model id may appear in at most one upstream; `protocol` is `"anthropic"` (the only value with an adapter; anything else is refused); `authToken` is optional, and an upstream without one is called with no `Authorization` header. When `MODEL_UPSTREAMS` lists at least one upstream, `MODEL_BASE_URL` may be empty: then there is no `default` upstream and an unlisted model is unroutable. `MODEL_AUTH_TOKEN` is required whenever `MODEL_BASE_URL` is set. Any violation fails startup with a `validation` error naming the variable. Upstream URLs and tokens are held in memory only, every token is one of the Gateway's own secrets for ledger redaction, and no route returns a URL or a token. (Owner-decided: OWNER-DECISIONS item 15, "credentials installation-level only, all in Deskmates `.env`".)

2. **The proxy routes each request by its model id to that model's upstream.** After the frozen-model check (ADR-0023 decision 1, unchanged) and the CLI small-fast rewrite, the forwarded model id (the rewritten one for a rewrite) selects the upstream: the upstream that lists it, else `default`. `/v1/messages` and `/v1/messages/count_tokens` route the same way. The run token is replaced by that upstream's token, or removed when the upstream has none. A model with no upstream is answered `503 model_upstream_missing` with `x-should-retry: false`, a new typed `DeskmatesErrorCode`, and never forwarded. Budget admission (402, ADR-0032 decision 5), `model_requests` rows with usage and `served_model` (ADR-0023 decision 3), image-block counting and transport timing work unchanged for every upstream. (Owner-decided: item 9, multi-upstream registry approved.)

3. **No automatic fallback across upstreams.** The proxy never retries a request on another upstream, never redirects a failed or unreachable upstream, and never sends a request for a model to an upstream that does not serve it. An unreachable upstream is `502 upstream_unavailable` as before. `FALLBACK_MODEL` stays the SDK's own choice (ADR-0023 decision 3); it routes to its own upstream like any model, so a fallback on another upstream exists only because an operator configured it. (Owner-decided: item 15, "no auto fallback".)

4. **Any registered model may be chosen wherever a model is chosen.** `DEFAULT_MODEL`, `CHEAP_MODEL`, `FALLBACK_MODEL` and a bot's `model` / `cheapModel` override may name any model with an upstream. Startup refuses a `DEFAULT_MODEL`, `CHEAP_MODEL` or `FALLBACK_MODEL` with no upstream, and `POST`/`PATCH /api/bots` refuse an override with no upstream (`validation`), in addition to the existing price-row requirement. At start a run records `modelUpstreams`, the upstream id of each frozen model, in `runs.config_json` so its results can be attributed later; the frozen model ids themselves are kept on resume as before, and requests route by the registry in force (a registry change needs a Gateway restart). (Owner-decided: item 9, `qwen3.8-27b` as `CHEAP_MODEL`.)

5. **A local model is priced at an explicit zero.** A `MODEL_PRICES` row whose four rates are `0` is a known zero price: the run's cost is `0` USD, not `pricing_missing`, and its budget charge is a known zero, not an estimate. No zero is ever inferred for a model without a row. (Owner-decided: item 9, "local models priced as known zero".)

6. **Vision evidence is per upstream.** The vision probe cache key's `endpoint_sha256` (ADR-0023 amendment 1 decision 8) is the hash of the base URL of the model's own upstream. Keys of models on `default` are unchanged, so existing probe rows stay current; the same model id on two upstreams has separate evidence.

7. **Free models do not lower the unknown-price estimate.** (Proposed.) The `avg-unit-price-v1` estimate (ADR-0032 decision 4) averages over priced models whose rows are not all zero. A free local model says nothing about what an unpriced paid model costs; without this, adding three free local models would cut every estimate by most of its value. When every priced model is free, there is no estimate (unknown), as with an empty price table.

8. **The UI lists registered models with their upstream.** (Proposed shape.) `GET /api/config` adds `models`: the models the registry names explicitly plus `DEFAULT_MODEL`, `CHEAP_MODEL` and `FALLBACK_MODEL`, each as `{model, upstream}` with the upstream id only (never the URL or token), sorted by model id. The bot model and cheap-model pickers offer these as choices labelled with the upstream, and keep a free-text "another model" field for a model the `default` upstream serves without listing it.

## Alternatives considered

- **Upstreams in the database, edited from the UI.** Rejected by the owner (item 15): credentials stay in `.env`; the `secrets` table's `owner_kind = 'model'` stays unused.
- **Route by a frozen upstream id rather than the model.** Rejected: a model id is already the frozen fact the proxy checks, a registry change needs a restart, and storing an upstream id per request would need a `model_requests` migration for no routing benefit. The start-time `modelUpstreams` record covers attribution.
- **Fallback to another upstream on 5xx or connection failure.** Rejected (item 15). The SDK remains the only retry owner (ADR-0023 decision 3).
- **An external router (LiteLLM and similar) in front of the Gateway.** Not needed for Anthropic-protocol endpoints and adds a second credential holder (design §7.1 D).
- **Per-message model selection.** Not in v1 (item 15).

## Consequences

- A deployment adds a local upstream with one `.env` line and a zero price row, then sets `CHEAP_MODEL` or a bot override to one of its models; no migration.
- The stable deployment can keep its internal upstream as `default` and route `qwen3.8-27b` jobs to the GPU host. The operator scripts that require `MODEL_BASE_URL` are unchanged; an install with only `MODEL_UPSTREAMS` must not use them as-is.
- `model_requests` does not record the upstream id per request; the run's `modelUpstreams` and the model id identify it while the registry is unchanged.
- A refusal for a missing upstream is not a `model_requests` row (the `refusal` CHECK lists only `model_not_selected`); the SDK reports the 503 in the run's error.

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | `MODEL_UPSTREAMS` parses into upstreams after `default`; bad JSON, duplicate or reserved ids, bad URLs, empty or duplicated model lists, a non-anthropic protocol and a missing `MODEL_AUTH_TOKEN` fail startup; `MODEL_BASE_URL` may be empty only with upstreams; every upstream token is redacted as an own secret; `/api/config` carries no URL or token | `gateway/src/config/model-upstreams.test.ts`; `gateway/src/api/config-routes.test.ts` | none |
| 2 | two fake upstreams each receive only their own models' requests with their own token (none for a token-less one); `count_tokens` routes the same; the CLI rewrite routes by the rewritten model; frozen-model refusal and 402 admission precede routing; usage and `served_model` are recorded for both; an unroutable model is 503 `model_upstream_missing`, final, never forwarded | `gateway/src/model-proxy/upstream-routing.test.ts`; `contracts/src/errors.test.ts`; `gateway/src/api/errors.test.ts` | `model_requests` per model |
| 3 | a failing or unreachable upstream is answered once with its own status or 502 and no other upstream is called | `gateway/src/model-proxy/upstream-routing.test.ts` | none |
| 4 | startup refuses an unroutable `DEFAULT_MODEL`/`CHEAP_MODEL`/`FALLBACK_MODEL`; bot create and update refuse an unroutable override and accept a registered one on a non-default upstream; a started run records `modelUpstreams` | `gateway/src/config/model-upstreams.test.ts`; `gateway/src/api/bot-model-validation.test.ts`; `gateway/src/scheduler/model-upstream-freeze.test.ts`; `gateway/src/model-proxy/upstream-routing.test.ts` (a started run's record) | runs per upstream |
| 5 | a zero-priced model's usage prices to `0`, never `null` | `gateway/src/model-proxy/upstream-routing.test.ts` | `pricing_missing` events (0 for registered local models) |
| 6 | the probe key of a model on `default` equals the pre-ADR key; a model on another upstream keys on that upstream's URL | `gateway/src/model-jobs/vision-probe-upstream.test.ts` | none |
| 7 | all-zero rows are left out of the estimate population; an all-free table gives no estimate | `gateway/src/ledger/price-estimate.test.ts` | estimated share of spend |
| 8 | `/api/config` lists registered models with upstream ids; the bot pickers offer them labelled by upstream and still accept another id | `gateway/src/api/config-routes.test.ts`; web `features/contacts/model-picker.test.tsx` | none |
