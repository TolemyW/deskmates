# ADR-0020: Open internet by default, and a first visit asks instead of failing

Date: 2026-10-03
Status: accepted by the product owner on 2026-10-03 ("可以", after the proposal below)
Amends: the egress rule in `AGENTS.md`; ADR-0010 decision 1 ("It is not a default")
Amended by: ADR-0027 amendment 1 (decision 3: a private address or IP literal granted by a selected network profile is admitted, never asked for)

## Problem

Egress has been deny-by-default since design v0.3 §3.10: a workspace starts with an empty
allowlist, and a bot that opens any site not on it gets `egress_blocked`. The first deployment
test on 2026-10-03 showed what that means for a person: the bot was asked to look something up,
tried eight hosts including `example.com` and `github.com`, reported every one as blocked, and
correctly concluded that the workspace could not reach the web at all. The owner's verdict: a
product cannot ask people to type a list of hostnames before a bot can search; common sites must
not be blocked by default.

How comparable agents handle this, as of this writing:

- Claude Code (local CLI) does not restrict the network. Its `WebFetch` tool asks once per new
  domain, with "allow once" or "always allow this domain", and remembers the answer in the
  permission settings. `WebSearch` is allowed outright.
- Claude Code on the web creates the environment with one of three network policies: none,
  limited (a product-maintained allowlist of common hosts such as package registries and GitHub),
  or full. The person picks a policy; nobody types hostnames.
- OpenCode, Cursor, Cline and similar editors do not isolate the network; permissions are per
  tool, not per domain.
- Codex CLI's sandbox starts without network and opens it as a whole on approval or by config.
- Agents with their own virtual machine (Devin, Manus) browse the open internet; isolation is
  the machine, not a domain list.

None of them ask for a list up front. Either the default is open, or the product ships the list,
or the first visit asks and the answer is remembered. Deskmates already has the pieces for the
third: the approval machinery of ADR-0002 (a request in the chat, Allow once / Always / Deny,
a parked run that resumes on the decision) and the managed proxy of ADR-0006/ADR-0010 that
applies an allowlist live.

## Definitions

- **Open workspace**: an allowlist of the single entry `*` (ADR-0010): any public hostname,
  never a private address or an IP literal.
- **Locked workspace**: any other allowlist, the empty one included. Only the listed hosts are
  reachable without asking.
- **Egress ask**: an approval of kind `egress`, posted by the sidecar's `PreToolUse` hook when a
  navigation, a `browser_tabs` open or a shell `curl`/`wget` names a public host outside the
  list. It carries the tool, the host as `targetOrigin` and the URL as `argumentSummary`, never
  page content.

## Decisions

1. **A new workspace is open unless its creator locks it.** `POST /api/workspaces` without
   `egressAllowlist` creates the list `["*"]`; a body that carries a list, the empty list
   included, is kept as sent. The UI's workspace forms (first run, New workspace, the Shared
   computer settings) offer two modes, "Open public internet" (the default) and "Only these
   sites" with the list; a `*` is never typed by hand. The default grouping rule of ADR-0004
   and ADR-0010 decision 5 are unchanged: an open workspace is an untrusted-browsing
   workspace that holds no production credentials, and the UI says so where the mode is chosen.
2. **In a locked workspace, a first visit to a public host asks; it does not fail.** The hook
   posts an egress ask through the ADR-0002 path (short wait, then park) instead of returning
   `egress_blocked`. The decisions are **allow this site** (`allow_always`) and **deny**; there
   is no `allow_once`, because the managed proxy enforces the same list and a one-off tool-level
   allowance would still be refused at the network. `allow_always` adds the host to the
   workspace allowlist through the same path as an operator edit (proxy first, then the row,
   then a log line in every live run and a `workspace` frame on the bus) before the approval is
   settled, so the host is admitted by the time the run continues. It stores no tool rule, and
   no tool rule ever answers an egress ask. A deny carries the decider's reason to the bot, as
   for any approval, and "tell it what to do instead" works the same way.
3. **What is never asked for stays denied.** A private address, an IP literal, a loopback or
   link-local name, a URL that cannot be read, and the URLs of a `browser_cli_workflow` step
   are denied outright as before, in an open and in a locked workspace alike. ADR-0010
   decision 2 is unchanged.
4. **The agent still cannot edit the list.** The only writers are the operator routes and an
   egress decision taken by a human in the UI or by a bot through `approval_decide`; a deciding
   bot is the soft boundary of ADR-0002 amendment 2, not a security boundary. The sidecar's
   copy of the list is refreshed before every navigation check as before, so a host allowed
   from the chat is seen by the hook on its next call.

## Consequences

- The "Attention" inbox and the chat show a card titled "Open <host>?" with the page, the
  reason, and the two decisions. The card is the same component as a tool approval.
- A locked workspace's list grows one host per answered ask. The Shared computer settings page
  shows the list and lets an operator remove hosts, with the existing removal confirmation.
- `AGENTS.md`'s rule reads "egress is open by default and locked by choice; a locked
  workspace asks on the first visit" instead of "deny-by-default". The sidecar's tool-level
  enforcement is still a guard rail, not isolation (unchanged); the managed proxy is the
  enforcement that matters, and it reads the same list.
- A deployment that runs the managed proxy with `*` needs `EGRESS_PROXY_DNS` or
  `EGRESS_PROXY_DOH_URL` as ADR-0010 decision 4 and amendment 1 describe; nothing here changes
  that.

## Alternatives

- A product-maintained list of common sites: rejected for now; every such list is arbitrary,
  stale the day it ships, and still fails on the first site it does not name. It can be added
  later as a preset for locked workspaces without touching this decision.
- `allow_once` for an egress ask: rejected; it would work at the tool level and fail at the
  proxy, which is the worse kind of surprise.
- Keep deny-by-default and improve the error text: rejected by the owner; the error was
  already clear and the bot already explained it well. Clarity was not the problem.

## Verification

| Decision | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | `POST /api/workspaces` without a list stores `["*"]`; an explicit list, empty included, is stored as sent; the UI forms send `["*"]` for the open mode and the typed list for the locked mode | T1 `packages/gateway/src/workspaces/egress-policy.test.ts` ("workspace creation default"); T0 web `thread.test.tsx` first-run form, `management.test.tsx` egress editor | share of workspaces created open (reported) |
| 2 | A navigation, a `browser_tabs` open or a shell fetch to a public host outside the list posts an approval of kind `egress` naming the host and the URL; a deny denies the call; an allow lets it through and records the origin; `allow_always` adds the host to the allowlist before the approval is settled and creates no rule; `allow_once` is refused with 400; a deny leaves the list alone | T0 `packages/sidecar/src/run-once.test.ts` ("asks for a public host", "an allowed egress ask", shell and tabs cases); T1 `egress-policy.test.ts` ("allow this site adds the host", "refuses allow_once"); T0 web `approval.test.tsx` ("egress approval card") | egress asks per day and their decisions (ledger `approval` events with kind `egress`) |
| 3 | Private, IP-literal, loopback and unreadable targets are denied without an ask, under `*` and under a list | T0 `run-once.test.ts` ("never asks for a private address", "under '*' allows public hostnames and denies IP literals") | zero egress asks naming a non-public host |
| 4 | No run route writes the list; the decision route is the only non-operator writer, and it writes exactly the asked host | T1 `egress-policy.test.ts`; existing `operator-auth.test.ts` (run tokens never reach operator routes) | zero agent-originated list changes outside an answered ask |

## Verification state (2026-10-03)

The T0 and T1 tests named above pass on this branch (sidecar 92, gateway and web suites green).
The managed proxy's behaviour with a host added mid-run is covered by the existing proxy policy
tests through the unchanged `updateEgress` path; a live check on the stable deployment (open a
locked workspace, visit a new site, allow it from the chat, see the page load) is owed in the
release runbook before the next tagged release.

## Test correction (2026-10-05)

The v0.2.19 release-day full T2 run exposed an obsolete inline-snapshot assertion:
an off-allowlist public host was expected to return `egress_blocked` and finish,
while decision 2 requires a parked egress approval. The corrected
`acceptance/m2-browser-inline-snapshot.container.test.ts` checks that the real
SDK parks with the exact egress action, a human denial resumes the same logical
run without changing the allowlist, and neither the wait nor denial generates
an inline snapshot, screenshot or acquired browser target. A separate case
retains decision 3's immediate private-address denial without an approval.
All three cases passed against v0.2.19's exact production images on Testbox,
with only the test source changed and a scripted upstream (no configured-model
calls). Source hashes and the full-regression outcomes are recorded in the
[stable release runbook](../runbooks/stable-release.md). This verifies park and
deny, not the still-owed live allow-this-site/resume journey.

## Release-bound runtime journey (2026-10-05)

Before the v0.3.0 internal-trial minor release, the same T2 file additionally
exercised allow-this-site through the actual SDK, MCP, Chromium and managed
proxy, on Testbox with v0.2.19's exact production image IDs. A locked isolated
workspace asked for `https://www.baidu.com/`, parked, received the authenticated
operator `allow_always` decision, added only that host, created no tool rule,
resumed the same logical run and loaded the public page. The complete result
received by the scripted upstream retained both untrusted wrappers; the capture
RPC completed successfully. This closes the release-bound runtime journey while
respecting the stable instance's test isolation rule; no stable database or
workspace was used, and no configured-model call or operator-UI visual acceptance
is claimed.

Three preliminary test outcomes remain retained: a two-block assumption on the
truncated ledger, then a wrapper-count check on that same truncated ledger, then
an absent screenshot ledger entry after SDK replay. The final test checks full
wrapping at the actual upstream and capture RPC completion; all four cases passed
in 51 seconds. The absent replay-capture ledger entry remains an observability
gap, not a repaired or passed screenshot-attribution claim. Logs, source hashes
and the full-regression results are retained in the stable release runbook.
