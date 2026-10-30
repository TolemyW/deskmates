# ADR-0049: An egress-governed `web_search` tool on a self-hosted SearXNG

Date: 2026-10-18
Status: Accepted (in part; owner-decided 2026-10-18, in chat with the coordinator, on the recommendation "自建 SearXNG，sidecar 提供 `web_search` 工具": "可以，最好是能做个对比，看看效果"): a self-hosted SearXNG instance as the backend, a sidecar `web_search` tool proxied by the Gateway, and a paired comparison of browser-only against browser plus `web_search` before the tool is recommended as a default. The engineering choices below (the request and result bounds of decisions 5 and 7, the per-run cap, the result host filter, L0 with no approval in any mode, the per-workspace switch that is off by default, the run-config stamp, the release image and the `stable.sh searxng` commands) are Proposed for owner review. Implemented 2026-10-18 with T0/T1 tests against a fake SearXNG; the release image, `stable.sh searxng` and a live SearXNG are not verified (no Docker on the authoring host). The comparison is prepared, not run: `docs/design/web-search-evaluation-protocol-2026-10-18.md`, task set `evals/tasks/web-search-v1.json`, `npm run web-search-eval`; its scripted dry run passes model-free in T1, and its Docker half has not been executed.
Builds on: ADR-0002 (risk tiers), ADR-0010 and ADR-0020 (egress), ADR-0040 (Gateway-proxied operations), ADR-0045 (redaction of what leaves), ADR-0046 (a loopback service beside the Gateway under `stable.sh`); issue #3, roadmap item C2.

## Context

The SDK's `WebSearch` and `WebFetch` are withheld from every run (`DISALLOWED_TOOLS` in `packages/sidecar/src/run-once.ts`): they reach the network without a URL the `PreToolUse` hook could check against the workspace's egress allowlist, so they would bypass ADR-0020. The browser is therefore the only way a bot can search, and searching through it is expensive: open a search engine, take a snapshot, read a results page built for people, often a consent wall or a bot check first.

The long-horizon campaigns of 2026-10-11/12 (issue #3) measured the consequence. Bots ran 22 searches in six hours when the browser was the only way. The market-analysis deck v1 built its competitive landscape from the model's memory; v2, whose brief forced a discovery phase, ran more than 60 logged searches and moved the rubric score from 40 % to 81 %, with the same team and model. Discovery is where the work is, and the platform makes it costly.

The coordinator compared the options with the owner on 2026-10-18 and recommended a self-hosted SearXNG behind a sidecar tool; the owner agreed and asked for a comparison of the effect.

## Decision

1. **`web_search` is a sidecar tool proxied by the Gateway.** The tool posts `{ query, maxResults?, language? }` to `POST /internal/runs/:runId/search` with the run's token, like every internal route; another run's token is refused. The Gateway builds the one upstream request from a fixed template, forwards it once with no retry and no fallback, records the call (decision 11) and returns the checked results. It never fetches a result URL, never resolves a result host, never starts a search on its own and never calls a generative model (the thin-core rule is unchanged: SearXNG is a metasearch engine, not a model).

2. **Installation configuration, off unless configured.** `SEARCH_URL` is the SearXNG base URL (`/search` is appended unless the URL already ends in it); `SEARCH_AUTH_TOKEN` is an optional Bearer for an instance behind an authenticating proxy, kept in Gateway memory, never stored, never sent to a sandbox and never in a row or an error. Both are read in `packages/gateway/src/config/search.ts`; a malformed URL, or a token without a URL, stops startup. Without `SEARCH_URL` no run is offered the tool and runs are unchanged byte for byte. The workspace container never learns the address: only the Gateway talks to SearXNG, which on the stable deployment listens on the host's loopback (decision 14).

3. **The upstream request is a fixed template.** `GET <SEARCH_URL>?q=<query>&format=json&pageno=1&safesearch=1`, plus `&language=<language>` when given; `Accept: application/json`; a 15-second timeout. The run chooses only the query text, the language and how many of the answer's results it gets back; it cannot choose the endpoint, the engines, the categories or any other SearXNG parameter. SearXNG's JSON output must be enabled on the instance (`search.formats` includes `json`); an HTML answer is `answered_malformed`.

4. **A per-workspace switch, off by default.** `GET /api/workspaces/:id/web-search` (Members) and `PUT` with `{ enabled: true | false | null }` (Owner or Admin; `null` returns to the default) hold the workspace's choice; every change is audited as `workspace.web_search_set`. The default is **off**: offering a new tool changes the prompt and the tool list, which is a strategy change (AGENTS.md), so it is not on for anyone until a person turns it on for their workspace or the comparison (decision 13) supports a different default. Turning it on is refused with `validation` on an installation without `SEARCH_URL`; a stored "on" on an installation that later drops the variable is inert. The Web shows the setting on the workspace page, in every locale, with what the switch means (decision 9).

5. **Request bounds, checked on both sides before anything leaves.** Query: 1 to 400 characters after trimming, no control characters. `maxResults`: 1 to 10, default 5. `language`: a language tag such as `en`, `zh` or `zh-CN` (`^[a-z]{2,3}(-[A-Za-z]{2,4})?$`), or absent. The sidecar's tool schema enforces these and the Gateway checks them again, refusing anything else with `validation` and no upstream call. A run may forward at most 50 searches; the 51st and later are refused with `rate_limited` and recorded, so a looping bot cannot turn the installation's SearXNG into a scraper that gets it banned by the engines behind it.

6. **The query is redacted before it leaves.** The sidecar passes the query through `redactText` (`packages/sidecar/src/redact.ts`, the module that scrubs the ledger) with the run's own model token as a known secret, so bearer tokens, `sk-` keys, credential assignments and credential query parameters never reach SearXNG or the engines behind it; the tool result tells the bot when its query was redacted. The Gateway replaces the run's own token once more if it still appears (defence in depth: the Gateway knows that token from the request). Redaction is pattern-based: a secret that looks like ordinary words is not caught, which the tool description says.

7. **Results are checked, filtered and bounded.** The Gateway keeps, from the answer's `results`, items with a string `url` and `title`; `content` becomes the snippet and `engine` (or the first of `engines`) the engine. Each title is cut to 300 characters and each snippet to 600, control characters removed. A URL must be `http` or `https`, at most 2048 characters, with no user name or password. Its host must be one the open-internet allowlist `*` would admit (`isPublicHostname`: not an IP literal, not `localhost`, not the reserved host, no numeric last label), must have at least one dot and must not end in `.local`, `.localhost`, `.internal`, `.lan`, `.home`, `.corp` or `.arpa`. The one exception: a host that an explicit entry of the workspace's own allowlist names (an exact name or a `*.suffix` entry, never `*`) is kept, so a locked workspace that lists an internal name can find its own pages; **an IP literal is dropped whatever the allowlist says**. Duplicate URLs are dropped. The first `maxResults` survivors are returned with `dropped`, the number filtered out. Answers with no `results` array are `answered_malformed`.

8. **Results are untrusted.** Titles and snippets are written by the pages and the engines, so the tool result is wrapped as `<untrusted source="search:web">` and entity-escaped like page text (`packages/sidecar/src/untrusted.ts`); an injected closing tag cannot leave the wrapper. The ledger keeps the raw tool result; the wrapper exists only in model context.

9. **Opening a result is the existing path, under the existing rules.** No fetch tool comes with search. A bot opens a result with the browser or `curl`, and the `PreToolUse` hook judges that call as it judges any other: in an open workspace a public host is allowed; in a locked workspace a first visit to a host outside the list is the usual egress approval in the chat (ADR-0020), never silently allowed because a search returned it; a private address, an IP literal or an unreadable URL stays denied. Searching itself is not an egress event: the destination is installation configuration that the Gateway reaches, and a locked workspace may search. What that means, and what the workspace page says next to the switch: **the query text leaves the installation**, through SearXNG to the public engines it is configured with, even from a locked workspace. A workspace whose data must not appear in a query to a public engine keeps the switch off.

10. **Tier L0, no approval in any mode.** `web_search` reads; it changes nothing in the workspace or on the world beyond sending the query (decision 9), which is the same information flow as typing the query into a search engine in the browser of an open workspace. The hook allows it in `manual`, `automatic` and `approve_all`. The per-workspace switch (decision 4) is the control for workspaces where that flow matters.

11. **Every forwarded call, and every refusal by the run cap, is recorded.** (A request refused for its shape under decision 5 never names a run's search and is not recorded, as an operation's validation refusal is not.) A `search_requests` row per call holds workspace, run, attempt, `endpoint_sha256`, status (`succeeded`, `failed`, `refused`), error code, `query_sha256` of the query as sent, its length in characters, whether the sidecar reported a redaction, the language, the requested maximum, the result count, the dropped count and the latency. The run's ledger gets one `log` event with source `search`. No query text, no result, no URL and no credential is stored by the Gateway. Search has no unit price: a self-hosted SearXNG bills nothing, so no `budget_charges` row is written and admission is unchanged (the model calls that read the results are priced and charged as before). A paid search backend would need an amendment that prices it.

12. **Offered when configured and on, frozen on the run row.** When the installation configures `SEARCH_URL`, the first start of every run (attempt 1) records `webSearch: "on" | "off"` and `webSearchVersion: 1` in `runs.config_json`, and `webSearchEndpointSha256` when on; a later attempt keeps what attempt 1 recorded, whatever the switch says now. `on` requires the workspace's switch to be on and the run to be a bot's own run (a Gateway job such as a review, a summary or a probe is `off`). A run is offered the tool exactly when its row says `on`, and the proxy refuses a run whose row does not (`not_found`, with no upstream call), so turning the switch off stops new runs, not a run already started. On an installation without `SEARCH_URL` nothing is recorded. A run that is offered the tool also gets one line in the prompt's "Extra tools" list naming it and saying that results are data and that opening one follows the workspace's egress rules; nothing else in the prompt changes.

13. **The default changes only on the paired comparison.** The tool and its prompt line are one strategy change. The comparison of browser-only against browser plus `web_search` (protocol `docs/design/web-search-evaluation-protocol-2026-10-18.md`, task set `evals/tasks/web-search-v1.json`, `npm run web-search-eval`) is the gate: until its decision rule says adopt on a complete campaign, the default stays off and no document calls the tool "better". A person may turn it on for their own workspace before that, as their choice.

14. **A release image and `stable.sh searxng`.** `images/searxng` builds from the official image pinned to an exact release and its index digest, with `settings.yml` preinstalled: `use_default_settings: true`, JSON output on, the limiter and the image proxy off (one trusted client, the Gateway), metrics off, listening on `127.0.0.1`. `stable.sh searxng init` builds the image for the current release and writes a random secret into `searxng/secret` (0600) under the stable root; `start` runs one container on the host network beside the Gateway, like Grafana (ADR-0046 decision 6), on `SEARCH_PORT` (default 18710), and warns when `SEARCH_URL` in `shared/.env` does not point at it; `stop` and `status` do what they say. The engines SearXNG queries are its defaults; choosing others is the operator's edit of the instance, outside Deskmates. An installation may point `SEARCH_URL` at any SearXNG it runs itself.

## Alternatives considered

- **Offer the SDK's `WebSearch`.** It bypasses the hook's egress check (ADR-0020), it is a server tool of one provider's API that the Anthropic-protocol gateways in front of other models do not implement, and the Gateway could not record or bound it.
- **A hosted search API (Brave, Bing, Tavily, SerpAPI).** Paid per query, needs a key per installation, and sends every query to one more third party. The adapter of decision 3 is small and protocol-specific; such a backend can be added later behind the same tool by an amendment that also prices it (decision 11).
- **Let the sidecar call SearXNG directly.** The workspace would need a route to the instance and its address, the call could not be recorded or bounded by the Gateway, and a bot could aim the same route elsewhere.
- **Fetch and summarise the result pages in the Gateway.** That is a second browser outside egress governance, and summarising needs a model in the control plane.
- **On by default wherever `SEARCH_URL` is set**, as ADR-0040 decision 2 offers its operations. Rejected for search: it is a tool the bot chooses to use for its work, which is exactly what the strategy rule protects; the owner asked for the comparison first.
- **An approval per search.** It would recreate the cost that keeps bots from searching; the per-workspace switch is the control.

## Consequences

- Where a workspace turns it on, a bot can discover pages in one call and open the ones it needs; the effect on task outcomes is unknown until the comparison runs.
- Query text leaves the installation to the engines behind SearXNG, from locked workspaces too (decision 9). The installation's SearXNG address and any token stay in the Gateway.
- `search_requests` grows by one row per call.
- A run on an installation with `SEARCH_URL` set gets two or three more keys in `runs.config_json`; runs on other installations are unchanged.
- The stable deployment gains an optional loopback service with its own image, outside the Gateway's upgrade path.

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | the route forwards exactly one request per call, never retries a 5xx or a network failure, and refuses another run's token with no upstream call | T1 `packages/gateway/src/search/search-routes.test.ts` | `search_requests` rows per run |
| 2 | unset means no tool and no stamp; a base URL gets `/search`; a bad URL or a token without a URL stops startup; the token goes upstream as Bearer and is never in a row or an error | T0 `packages/gateway/src/config/search.test.ts`; T1 `search-routes.test.ts` | none |
| 3 | the upstream URL carries `q`, `format=json`, `pageno=1`, `safesearch=1` and the optional language and nothing the request names beyond them; an HTML answer is `answered_malformed` | T0 `packages/gateway/src/search/searxng.test.ts`; T1 `search-routes.test.ts` | failed rows by reason |
| 4 | the default is off; Members read, an Owner or Admin sets and clears; turning it on without `SEARCH_URL` is refused; every change is audited; the Web section shows the setting and the information flow in every locale | T1 `packages/gateway/src/api/web-search-routes.test.ts`; T0 `packages/web/src/features/web-search/web-search-section.test.tsx`; the permission matrix | workspaces with search on |
| 5 | an empty or long query, a control character, a bad `maxResults` or language is refused with no call; the 51st search of a run is refused as `rate_limited` and recorded | T0 `packages/contracts/src/web-search.test.ts`; T1 `search-routes.test.ts` | refused rows by reason |
| 6 | a bearer token, an `sk-` key and the run's own token are replaced before the query leaves the sidecar, and the result says so; the Gateway replaces the run's token again | T0 `packages/sidecar/src/web-search-tool.test.ts`; T1 `search-routes.test.ts` | redacted share of searches |
| 7 | IP literals, `localhost`, the reserved host, single-label and internal suffixes, non-HTTP schemes and URLs with credentials are dropped; an explicit allowlist entry keeps its host but never an IP literal; duplicates are dropped; titles and snippets are cut; `dropped` counts them | T0 `packages/contracts/src/web-search.test.ts`, `packages/gateway/src/search/searxng.test.ts` | dropped per search |
| 8 | the result is wrapped as `search:web` and an injected closing tag is escaped | T0 `packages/sidecar/src/web-search-tool.test.ts` | none |
| 9 | in a locked workspace a navigation to a host a search returned, outside the list, still asks for egress; a private address from a result stays denied | T0 `packages/sidecar/src/web-search-egress.test.ts` | egress asks after a search |
| 10 | `web_search` is L0 | T0 `packages/sidecar/src/web-search-tool.test.ts` | none |
| 11 | a success records query hash, length, redaction flag, counts and latency and no query text; failures and run-cap refusals are recorded; one `log` event per call; no budget charge | T1 `search-routes.test.ts` | searches per run, p50/p95 latency |
| 12 | with search configured, attempt 1 records `webSearch` on or off and the endpoint hash when on, a resume keeps it, a Gateway job is off; the tool and the prompt line come exactly with `on`; the proxy refuses a run recorded `off`; without `SEARCH_URL` nothing is recorded | T1 `packages/gateway/src/search/web-search-offer.test.ts`, `search-routes.test.ts`; T0 `packages/sidecar/src/web-search-tool.test.ts` | runs with `webSearch: on` |
| 13 | the comparison has a task set with deterministic oracles, a plan from `evals/power.ts`, a decision rule on `evals/compare.ts` and a scripted dry run; nothing runs by default | T0 `evals/web-search-eval.test.ts`; T1 `evals/web-search/dry-run.test.ts` | the campaign's decision |
| 14 | the image is pinned to a release and an index digest, ships settings with JSON on, the limiter off and a loopback bind, and copies nothing else; `stable.sh` knows `searxng init`, `start`, `stop` and `status` | T0 `images/searxng/dockerfile.test.mjs`; T0 `scripts/stable/stable.test.mjs` | none |

## Amendment 1 (2026-10-22): search defaults on, beside network settings

Status: accepted by the owner on 2026-10-22. The owner explicitly requested enabling search in
the reported workspace, making it the code default and placing it alongside network settings.
This supersedes decisions 4 and 13's default-off gate, not the pending quality comparison.

15. **Configured installations inherit on.** With `SEARCH_URL` configured, a workspace with no
    stored choice offers `web_search` to new bot runs. An explicit `false` remains off; resetting
    to `null` inherits on. Without the backend the effective setting stays off. Existing runs
    keep their frozen setting, including on resume. The switch appears beside Network policy
    in Tools & network, in both Use and Tune, with the existing information-flow disclosure.
    No migration, credential change, extra fetch capability or pricing change is introduced.
    This is the owner's product choice; the paired comparison remains pending and is still
    required before claiming improved search quality.

16. **New bot runs carry `researchGuidance: verify-v1`.** The sidecar's fixed guidance asks for
    an exact-name/domain search for unfamiliar entities and changing facts, then primary-source
    verification and supporting links. It uses `web_search` when offered, otherwise the browser;
    blocked or inconclusive research is reported as uncertainty rather than a familiar-name
    substitution. It adds no deterministic tool requirement or new denial. New run rows record
    the strategy; start/resume forward that frozen value. An older run without it retains its
    earlier prompt. Model/presentation jobs do not get this guidance. This is a strategy change,
    with no paired real-model quality result yet; unit tests verify the wiring, not that a model
    will follow the text. The Jev regression is evidence of a failure mode, not an A/B result.

17. **Empty results during engine errors are unavailable evidence.** If SearXNG returns no raw
    results and a nonempty `unresponsive_engines`, record a failed search with
    `engines_unavailable` and return `operation_unavailable`, without retrying. Never expose
    arbitrary upstream diagnostic text or classify that answer as a healthy no-match. Useful
    results from a partial outage remain usable; a clean empty result remains a successful
    search. The sidecar's failure text points to browser fallback or honest uncertainty.

### Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 15 | configured default/reset is on; explicit off persists, no backend stays off, resumed off remains off; the inherited-on UI can disable it and appears with network settings in Use | T1 `gateway/src/search/web-search-offer.test.ts`, `gateway/src/api/web-search-routes.test.ts`; T0 `web/src/features/web-search/web-search-section.test.tsx`, `web/src/features/workspaces/workspace-management.test.tsx` | new bot runs with search available; paired quality comparison pending |
| 16 | the run stamps and forwards `verify-v1`, resumes keep it; older requests get no changed prompt; guidance covers exact names, browser fallback and primary sources | T0 `gateway/src/ledger/run-config.test.ts`, `sidecar/src/context.test.ts`; T1 `gateway/src/default-bot/default-bot.test.ts` | unfamiliar-entity answers grounded in primary sources; paired measurement pending |
| 17 | empty plus engine errors is failed once with no result count; clean no-match and partial useful results keep their semantics | T0 `gateway/src/search/searxng.test.ts`; T1 `gateway/src/search/search-routes.test.ts`; T0 `sidecar/src/web-search-tool.test.ts` | failed searches by `engines_unavailable`; no-match answers during outages |
