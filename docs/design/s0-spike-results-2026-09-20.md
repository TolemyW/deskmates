# S0 Verification Week Results

Date: 2026-09-20
Corresponding document: `docs/design/design-cogbot-thin-core-v0.2-2026-09-20.md` section 8, S0
Code and logs: `spikes/s0/` (three directories, test-a, test-b, test-c; can be rerun)

Environment: macOS, Node 23.6, `@anthropic-ai/claude-agent-sdk` 0.3.278 (bundles Claude Code 2.1.278), `@playwright/mcp` 0.0.82, `@playwright/cli` 0.1.21, Docker 28.3 (colima, linux/arm64), container image based on `mcr.microsoft.com/playwright:v1.58.2-noble`. Model calls use `claude-haiku-4-5-20251001` to keep cost down, about 0.03 to 0.05 USD per run.

## Conclusions at a glance

| Assumption | Result | Evidence |
|---|---|---|
| (b) An L2 action stops, the process exits, session resume continues the run | **PASS** | test-b: after the step1 process exits, a new step2 process resumes, the deferred command executes after approval, the agent replies DONE |
| (b') Short wait: the callback blocks in-process for 20 seconds and then allows | **PASS** | test-b/short-wait: the callback waited 20004 ms, AbortSignal did not fire, the tool executed, the run succeeded |
| (c) One Chromium used by Playwright MCP and noVNC at the same time | **PASS** | test-c: all 8 checks matched expectations (see below) |
| (c') Playwright CLI can also attach to the same browser | **PASS (documentation level)** | `playwright-cli attach --cdp=http://localhost:9222` is an officially supported command |
| (a) The SDK runs streaming + tools + cache through a Base URL proxy | **PASS** | test-a/run-endpoint: through the model gateway (Anthropic protocol), one run each with glm-5.3 and deepseek-v4.1-flash, both tool calls executed, the agent replied DONE, `cache_read_input_tokens` non-zero |
| (a') The model is swappable | **PASS** | Same script, only `SPIKE_MODEL` changed, both non-Anthropic models completed the task |

## (a) Model proxy: details

Two steps. Step one uses a local reverse proxy (`test-a/proxy.mjs`) to record every request the SDK sends; step two runs the full agent loop (`test-a/run-endpoint.mjs`) through a real Anthropic-protocol model gateway (URL not recorded here).

### Step two: real gateway end to end

| Item | glm-5.3 | deepseek-v4.1-flash |
|---|---|---|
| Tool call count (observed by hook) | 2 | 2 |
| Marker file written and read back | yes | yes |
| Final reply | DONE | DONE |
| `cache_read_input_tokens` reported by the SDK | 18176 | 18560 |
| Wall clock time | 14.0 s | 7.0 s |

Observed gateway behavior:

- Authentication accepts only `Authorization: Bearer <key>`; `x-api-key` returns `Authorization required`. The matching environment variable on the SDK side is `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`.
- The streaming response is standard Anthropic SSE: `message_start`, `content_block_start` (with both `thinking` and `tool_use` block types), `input_json_delta`, `message_delta` with `stop_reason: tool_use`, `message_stop`.
- The `usage` of a single curl --max-filesize 102400 request has only `input_tokens` and `output_tokens`, with no cache fields; but after several turns the SDK reported a non-zero `cache_read_input_tokens`, which shows the gateway returns cache hits on later turns.
- The `model` field in the response is the gateway's internal name (such as `glm53-internal`); the SDK's `modelUsage` still accounts under the requested model name, `costBasis` is `unknown`, the cost figure cannot be trusted, and the Gateway must price by token itself.

### Step one: local proxy observations

Characteristics of the requests the SDK sends; the model proxy must pass them through unchanged:

- Path `POST /v1/messages?beta=true`
- Request body `stream: true`, containing `system`, `tools` (29 built-in tool definitions), `cache_control` blocks (2 places)
- Request header `anthropic-beta`, a comma-separated list of beta flags, including `prompt-caching-scope-2026-01-05`, `extended-cache-ttl-2025-04-11`, `interleaved-thinking-2025-05-14`, `claude-code-20250219` and others
- Request header `anthropic-version: 2023-06-01`
- The response must be an SSE stream; the proxy must not buffer the whole body before returning it

Side finding: on this machine the SDK defaults to the OAuth Bearer token of the Claude Code login state. The same token succeeds when calling directly (test-b calls directly), but when forwarded to Anthropic through the local proxy it returns `403 Request not allowed`. This shows that **a subscription OAuth credential cannot be forwarded through a third-party Base URL**; the model proxy must hold its own API key and inject it at the egress. This matches the v0.2 section 3.2 design that "the bot does not hold the upstream key". After switching to the model gateway key in step two, the problem disappeared.

## (b) Approval persisted to disk and resumed: details

The SDK supports this flow natively; the "structured rejection" workaround written in v0.2 is not needed: the `PreToolUse` hook returns `permissionDecision: "defer"`, the query ends immediately and returns the session id; afterwards reopen with `resume: sessionId`, and the SDK runs the deferred tool call through the hook again; allowing it at that point executes it.

Observed sequence (test-b):

| Step | Event |
|---|---|
| step1 | The agent runs an L0 command (hook allows), the file `L0-DONE.txt` is written |
| step1 | The agent requests an L2 command, the hook returns `defer`, the run ends with `success`, `L2-DONE.txt` does not exist, the process exits |
| step2 (new process) | `resume` the same session, the hook receives the same L2 command again, allows it |
| step2 | `L2-DONE.txt` is written, the agent replies DONE |

Short wait mode (test-b/short-wait): the `canUseTool` callback returns allow after an `await` of 20 seconds, the SDK did not time out, the tool executed normally. The documentation states the callback may hang indefinitely.

Correction to v0.2: section 3.5 "persist and resume" changes to using `defer` directly; the agent no longer needs to output a mid-run summary. The mid-run summary can be generated by the sidecar itself as an optional user-facing hint.

## (c) Shared browser: details

test-c starts Xvfb, fluxbox, x11vnc, noVNC (websockify) and a headed Chromium with `--remote-debugging-port=9222 --user-data-dir=/profile` inside one container, then:

| Check | Result | Notes |
|---|---|---|
| Playwright MCP attaches to the running Chromium via `--cdp-endpoint` | PASS | 31 tools, including the 3 coordinate tools such as `browser_mouse_click_xy` added by `--caps vision` |
| MCP navigates and takes an accessibility tree snapshot | PASS | |
| Whether the accessibility tree can see a button inside a closed shadow root | **Cannot see it** (as expected) | Confirms the blind spot assumption in v0.2 C3 |
| A human clicks at the X11 layer (xdotool, equivalent to a noVNC user click) | PASS | Page title changes to PLAIN CLICKED |
| The agent's following MCP snapshot sees the result of the human's action | PASS | Same browser, same page, shared state |
| Visual fallback: MCP coordinate click hits the shadow button | PASS | Page title changes to SHADOW CLICKED |
| VNC frames can be captured, noVNC listens on 6080 | PASS | |
| Cookies written by MCP land in `/profile/Default/Cookies` | PASS | The premise that login state persists across runs holds |

The first run timed out because `npx @playwright/mcp@latest` inside the container triggered a download. The production image must preinstall MCP; it must not pull packages at run time.

Playwright CLI: `playwright-cli attach --cdp=<url>` is officially supported, `--persistent` and `--profile` support a persistent profile, `-s=<session>` supports multiple sessions. The premise that the three driving methods share one Chromium holds.

## Suggested changes to v0.2

1. Section 3.5: persist and resume uses the SDK's `defer` directly; delete the step "agent outputs a mid-run summary".
2. Section 3.2: state explicitly that the model proxy must hold the API key and inject it at the egress; a subscription OAuth credential cannot be forwarded. On the sandbox side, inject the gateway's short-lived token via `ANTHROPIC_AUTH_TOKEN`. Cost is what the Gateway computes itself by token; do not trust the SDK's `costUSD`.
3. Section 3.3: fix the MCP launch arguments as `--cdp-endpoint http://127.0.0.1:9222 --caps vision`; the CLI uses `attach --cdp`.
4. Section 8, S0: mark (a) (b) (c) all as verified.
5. Section 12 risk "session resume fails after approval is persisted": probability lowered from "medium" to "low".

## Unverified parts

- Session files across hosts: both test-b steps ran on the same machine. Rebuilding across containers needs a `SessionStore` adapter or mounting `~/.claude/projects/<cwd>/<id>.jsonl` on a persistent volume; in the v0.2 sandbox design `/home/bot` is a persistent volume, which would satisfy this, but it has not been run.
- "Locking" the browser during a human takeover so that MCP tools return a wait message: this is sidecar logic, not an SDK or Playwright capability, and was not implemented this time.
- Resume after a long (hours-level) `defer`: the interval this time was about 3 minutes.
- Implementation of the egress allowlist at the container network layer.
