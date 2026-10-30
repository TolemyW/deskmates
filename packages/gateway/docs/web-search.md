> Owner amendment, 2026-10-22: configured installations now default to on; explicit off is
> preserved. The switch is beside Network policy in Tools & network in both views. Existing
> runs keep their frozen choice. Historical default-off statements below describe the original
> launch; ADR-0049 amendment 1 governs current behavior. The paired quality gate is pending.

# Web search on a self-hosted SearXNG (ADR-0049)

A bot searches the web in one call with `web_search` instead of driving a search engine in the
browser. The sidecar redacts the query and posts it to the Gateway; the Gateway forwards it once
to the installation's SearXNG, filters the answer and records the call; the sidecar wraps the
results as untrusted. Opening a result is the bot's own browser or `curl` call, judged by the
`PreToolUse` hook under the workspace's egress rules like any other visit. The SDK's `WebSearch`
and `WebFetch` stay withheld. Code: `src/search/`, configuration in `src/config/search.ts`, the
sidecar tool in `packages/sidecar/src/web-search-tool.ts`.

## Configuration

Installation level only, in the Gateway's `.env` (see `.env.example`):

| Variable | Meaning |
| --- | --- |
| `SEARCH_URL` | The SearXNG base URL; `/search` is appended unless the URL ends in it. Unset: no run is offered the tool and run rows are unchanged. |
| `SEARCH_AUTH_TOKEN` | Optional Bearer for an instance behind an authenticating proxy; Gateway memory only, never in a row, an error or a sandbox. Set without `SEARCH_URL`, startup stops. |

The instance must answer `format=json` (`search.formats` includes `json` in its `settings.yml`).
The release image `images/searxng` does, and `stable.sh searxng init` / `start` runs it on the
host's loopback (`SEARCH_PORT`, default 18710), so the stable `.env` points at
`SEARCH_URL=http://127.0.0.1:18710`. Only the Gateway reaches it; the workspace container never
learns the address.

## The per-workspace switch

`GET /api/workspaces/:id/web-search` (Members) returns `{ configured, enabled, effective,
defaultEnabled: false, updatedBy, updatedAt }`; `PUT` with `{ enabled: true | false | null }`
(Owner or Admin) sets it, `null` returning to the default. **The default is off**: offering the
tool is a strategy change, and the default moves only on the paired comparison in
`docs/design/web-search-evaluation-protocol-2026-10-18.md`. Turning it on without `SEARCH_URL` is
refused (`search_not_configured`). Every change is audited as `workspace.web_search_set`. The Web
shows the switch in the workspace detail's Web search section.

Turning it on means the text of every search leaves the installation, through SearXNG to the
public engines behind it, **also from a locked workspace**. Opening a result still asks first when
its host is outside a locked workspace's list.

## What a run gets

On an installation with `SEARCH_URL`, the first start of every run records `webSearch: "on" |
"off"`, `webSearchVersion: 1` and, when on, `webSearchEndpointSha256` in `runs.config_json`. Later
attempts read it back; a Gateway job (a review, a summary, a probe) is `off`. A run recorded `on`
gets the `web_search` tool and one line in its prompt's "Extra tools" list; nothing else changes.

## Route

`POST /internal/runs/:runId/search` under the sandbox listener's run-token scope (another run's
token is 401), with `{ query, maxResults?, language?, redacted? }`:

- Query 1 to 400 characters after trimming, no control characters; `maxResults` 1 to 10 (default
  5); `language` a tag such as `en` or `zh-CN`. Anything else is 400 with no upstream call.
- A run whose row does not say `on` is 404; so is an installation without `SEARCH_URL`.
- At most 50 forwarded searches per run; later ones are 429 `rate_limited`, recorded as
  `refused` / `run_cap`.
- The run's own token is replaced in the query if it appears (the sidecar has redacted
  credentials already).
- One `GET <SEARCH_URL>?q=…&format=json&pageno=1&safesearch=1[&language=…]`, 15-second timeout,
  no redirects, no retry. A failure is 502 `operation_unavailable` with `reason` `answered_error`,
  `unreachable`, `timed_out` or `answered_malformed` (an HTML page, no `results` array).
- Answer `{ searchId, results: [{ title, url, snippet, engine }], dropped }`. Results keep `http(s)`
  URLs without credentials whose host `*` would admit, with a dot and no private suffix
  (`.local`, `.internal`, `.lan`, `.home`, `.corp`, `.arpa`), unless an explicit entry of the
  workspace's own allowlist names the host; IP literals are always dropped, as are duplicates.
  Titles are cut to 300 characters, snippets to 600.

## Records

One `search_requests` row per forwarded or rate-refused call: workspace, run, attempt,
`endpoint_sha256`, status, error code, `query_sha256` of the query as sent and its length, whether
it was redacted, language, requested maximum, result and dropped counts, latency. One `log` event
with source `search` per call in the run's ledger. No query text, result, URL or credential is
stored, and nothing is charged: a self-hosted SearXNG has no unit price.

## Not verified here

The release image, `stable.sh searxng` and a live SearXNG were not run when this was written (no
Docker on the authoring host); the T0/T1 tests use the testkit's `FakeSearxng`. Whether the tool
helps is what the paired comparison measures; nothing has been run.
