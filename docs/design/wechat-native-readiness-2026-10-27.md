# Native WeChat readiness

Date: 2026-10-27
Status: native implementation; live account acceptance not run, excluded from releases.

The owner authorized native WeChat development on 2026-10-27: QR authorization, one account
bound to one Bot, and direct messaging. ADR-0047's connection host and release gates apply.
The initial implementation accepts and replies with text; all media is refused with a notice.
It uses the documented iLink HTTP protocol without an OpenClaw process or adapter dependency.
This is not a claim about hosted-service permission, pricing, account eligibility or stability.

Protocol evidence: Tencent's [protocol reference](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)
and [QR client](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts), inspected
2026-10-27. These describe client wire behavior, not a verified server contract. QR status can
request additional verification; this implementation reports that unsupported flow explicitly.
Regional API origins are restricted to the default iLink host and its regional subdomains.
Unrecognized origins are refused before any credential is sent.

## Live release gates

Every row must have a passed result and a dated evidence description before the plugin enters
the standard release manifest. The development manifest is separate and explicitly requested.
`scripts/wechat-release-gate.mjs` enforces this; no account was linked by the development tests.

| Gate | Result | Evidence |
|---|---|---|
| W1 | not run | Region, account and client eligibility require an authorized phone account. |
| W2 | not run | Real token lifetime and same-account relink remain unverified. |
| W3 | not run | Concurrent platform authorizations remain unverified; local identity uniqueness is enforced by the existing host. |
| W4 | not run | Quotas and context-token lifetime remain unknown; no proactive send is offered. |
| W5 | not run | Current hosted-service terms and compatible-client permission require verification. |
| W6 | not run | A native protocol client is implemented; live compatibility, pricing and service level remain unverified. |
| W7 | not run | Phone scan, inbound, reply, restart, relink and disconnect have not been exercised on iLink. |
| W8 | not run | Actual media behavior remains unverified; the plugin refuses non-text items without downloading them. |

## Deterministic verification

`packages/channels/src/wechat/{api,plugin}.test.ts` uses an injected HTTP transport and fake
connection host, with no network or model. It checks identity claims/refusals, private state,
inbound deduplication, reply context, send acknowledgements, recovery, media/group refusals,
authorization expiry and destination restrictions. Existing Gateway connection-host tests own
workspace, role, identity uniqueness, blocklist and generation fencing guarantees.
`scripts/wechat-release-gate.test.mjs` checks exclusion from releases until evidence exists.
Deterministic checks do not close any live row above.

Local verification completed on 2026-10-27:

| Check | Result |
|---|---|
| Repository typecheck, lint, documentation consistency | Passed |
| Channels build and Web production build | Passed; Web retains its bundle-size warning |
| Affected channels, Gateway channel host, integrations UI and manifest tests | 57 files, 361 tests passed after the fixes |
| Stable-release script fixture and WeChat release gate | 2 files, 42 tests passed after adding the gate module to the release fixture |
| Full offline T0/T1 invocation | 914 files, 8,559 tests: 8,520 passed and 39 failed in two files before their fixes; both files passed their subsequent reruns. The full invocation was not repeated. |
| Built manifests through the actual Gateway loader | No load failures; regular manifest has no WeChat, separate development manifest includes WeChat |
| Pinned QR encoder | Generated a PNG data URL locally |
| Live WeChat, real-model and browser journeys | Not run |

The full invocation exposed a stopped-connection race (a late poll overwrote terminal status)
and a release-script fixture that omitted the new gate module. Both were fixed and retested.
No stable deployment, provider account or live credential was changed.

## PR validation on 2026-10-28

The PR branch was brought up to main `a910715` before validation. Typecheck, lint,
documentation consistency, Channels build and Web production build passed. The Web build
retains its existing bundle-size warning.

The first complete T0/T1 run passed 8,669 tests and hit the unchanged five-second timeout in
three stable-release script tests. A complete rerun with two Vitest workers, without changing
code or timeouts, passed all 924 files and 8,672 tests. This includes all 40 stable-release
script tests. The complete browser layout gate also passed: 3,240 tab-layout cases,
20 keyboard checks and all page-row fixtures, with no failures. Neither test run used a live
WeChat account or performed a deployment.

## Live journey to record

Use an isolated development Gateway and an explicitly authorized test account. Select WeChat,
choose one Bot, scan and confirm. Record redacted connection/thread/run IDs for a private text
and reply; redeliver an inbound event to check one run; restart and check continuity; rebind to
another Bot and verify the new-thread notice; relink the same identity and refuse a different
one; disconnect and confirm polling stops and private state is deleted. Check the phone's
authorization management separately: iLink's published protocol provides no logout endpoint,
so disconnect is local removal, not a claim of upstream token revocation. Real model/browser
test material belongs in the private lab repository per AGENTS.md.
