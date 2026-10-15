# Model upstreams (ADR-0039)

The Gateway can forward model calls to more than one Anthropic-protocol endpoint. The registry is
installation configuration read from `.env` at startup (`src/config/model-upstreams.ts`); it is
never stored in the database and no route returns an upstream URL or token.

## Configuration

- `MODEL_BASE_URL` / `MODEL_AUTH_TOKEN` are the upstream `default`. It serves every model id that
  no other upstream lists, which is how a single-upstream deployment has always worked.
- `MODEL_UPSTREAMS` is a JSON array of further upstreams:
  `{"id", "baseUrl", "authToken"?, "models": [...], "protocol": "anthropic"}`. The id is a
  lowercase slug and not `default`; a model id may be listed by one upstream only; `protocol` must
  be `anthropic`; without `authToken` the upstream is called with no `Authorization` header.
- With at least one entry in `MODEL_UPSTREAMS`, `MODEL_BASE_URL` may be empty: there is then no
  catch-all, and a model listed nowhere is unroutable.
- Startup fails when `DEFAULT_MODEL`, `CHEAP_MODEL` or `FALLBACK_MODEL` has no upstream, or on any
  malformed entry. Bot `model` / `cheapModel` overrides need an upstream as well as a price row.
- A free local model is priced with a `MODEL_PRICES` row of zeros: a known `0` USD, never
  `pricing_missing`. All-zero rows are left out of the unknown-price estimate's population.

Example for the tos-00 vLLM servers (no authentication), keeping an internal upstream as
`default`:

```
MODEL_UPSTREAMS=[{"id":"tos-9b","baseUrl":"http://172.17.120.16:8003","models":["qwen3.5-9b"],"protocol":"anthropic"},{"id":"tos-27b","baseUrl":"http://172.17.120.16:8004","models":["qwen3.8-27b"],"protocol":"anthropic"},{"id":"tos-vl","baseUrl":"http://172.17.120.16:8005","models":["qwen3.5-9b-vl"],"protocol":"anthropic"}]
CHEAP_MODEL=qwen3.8-27b
```

with zero rows for the three models in `MODEL_PRICES`.

## Routing

The model proxy checks the request against the run's frozen models first (403
`model_not_selected`), then budget admission (402 `budget_exhausted`), then resolves the
upstream from the forwarded model id (after the `CLI_SMALL_FAST_MODEL` rewrite). The run token is
replaced by that upstream's token or removed. A model with no upstream is 503
`model_upstream_missing` with `x-should-retry: false`. There is no fallback to another upstream:
an upstream error or 502 `upstream_unavailable` is the answer. `model_requests` usage and
`served_model` are recorded for every upstream.

At start each run records `modelUpstreams` (frozen model id → upstream id, `null` for none) in
`runs.config_json`. Requests route by the registry in force; changing `.env` needs a restart.

Vision probe keys hash the base URL of the model's own upstream, so models on `default` keep
their existing evidence.

`GET /api/config` returns `models`, the registered model ids with their upstream ids, which the
bot model pickers list.
