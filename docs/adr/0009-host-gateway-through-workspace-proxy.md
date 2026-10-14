# ADR-0009: Reach the host Gateway through the workspace proxy

Date: 2026-09-24
Status: accepted for implementation by the product owner on 2026-09-24; live acceptance pending
Supersedes: the direct host reachability mechanism in ADR-0006 decision 3
Amended by: ADR-0027 amendment 1 (decision 4: root-selected network profiles may admit explicit LAN origins; the reserved host path is unchanged)

## Problem

M2 closeout on macOS with Colima found that an internal-only workspace cannot reach
its Gateway. The provider maps `host.docker.internal` to the workspace bridge's
address. That address belongs to the Linux Docker VM; the Gateway runs on macOS.
The workspace has no route to the macOS address. A real SDK run starts but fails
its model request and ledger callbacks with connection refused. Two real workspace
probes reproduced the failure. The VM itself can reach a disposable macOS listener.

The existing mapping works when the Gateway runs on the Docker daemon's Linux host.
It does not meet this repository's documented local Colima workflow. Granting the
workspace an outbound network would defeat the egress boundary and is rejected.

## Decisions

1. **Keep each workspace on its own internal network.** Do not add an outbound
   interface, general route, elevated capabilities, or a shared workspace network.
   The existing dual-homed egress proxy remains the route out.
2. **Forward the reserved host name through that proxy.** Requests to the exact
   `host.docker.internal` name reach a deployment-selected host address from the
   proxy's outbound side. On Colima this is the macOS host; on native Linux it is
   the daemon host. This infrastructure target is operator-controlled, never
   derived from page content, model output, or the workspace's editable files.
   Preserve the existing documented host-service exception, including ephemeral
   acceptance fixture ports; do not describe it as Gateway-only isolation.
3. **Use the same path in every runtime client.** Sidecar HTTP callbacks, the SDK
   model client, Chromium and governed shell/CLI clients must use the managed proxy
   for the reserved name. Remove the reserved name from direct bypass lists.
   Explicitly verify Node fetch and SDK proxy behavior; environment variables alone
   are not evidence. Loopback/CDP stays container-local. No upstream model or
   operator credential is placed in proxy configuration.
4. **Keep ordinary destinations deny-by-default.** The reserved-name case cannot
   become a private-IP, arbitrary-host, redirect, DNS-rebinding or CONNECT bypass.
   Existing public-domain policy and revocation behavior remain in force. Requests
   through the host exception still encounter the split Gateway listeners and
   their credential checks. The host exception may expose other host services,
   as before; deployment operators must secure those services.
5. **Fail clearly and preserve lifecycle behavior.** Validate host-target/proxy
   configuration, persist infrastructure configuration across attach/restart,
   and fail closed if it is absent or invalid. Restore connectivity without
   altering run deadlines, tool risk rules, model strategy, or test oracles.

## Alternatives

- Keep the direct mapping and require the Gateway to run inside the Linux VM:
  valid for that deployment, but does not repair the current macOS development flow.
- Attach the workspace to an outbound bridge: rejected; bypasses managed egress.
- Add machine-wide forwarding/firewall rules: rejected for this batch; changes host
  state outside the provider lifecycle and makes clean local setup harder to verify.

## Verification (required before acceptance)

| Decision | Concrete meaning | Executable proof | Metric |
| --- | --- | --- | --- |
| 1 | Workspaces have one internal interface and cannot reach siblings or direct public IPs | Existing/new cases in `acceptance/m2-boundaries.container.test.ts` | Zero successful forbidden connections |
| 2 | Reserved-name traffic reaches the configured host through the proxy on Colima and Linux | Proxy host-target unit tests; B4 real host fixture; native Linux run | Host fixture succeeds on both deployment shapes |
| 3 | SDK, ledger, MCP browser and shell use the reachable path | `m0-stack.container.test.ts`, `m2-browser.container.test.ts`, explicit shell/fetch probe | Complete SDK run with ledger, expected browser state |
| 4 | Host exception does not widen ordinary egress or credentials | Proxy policy tests; B4 allow/deny/revoke/split-listener cases | Zero unapproved destination or operator-route successes |
| 5 | Restart/attach restores infrastructure and starts public policy deny-all | Provider lifecycle tests and B4 proxy restart case | Restart probes have expected success/denial, no leaked resources |

The tests above identify the required evidence; proposed cases and platform results
are not yet implemented or accepted. The owner approved implementation of these
constraints, not a claim that M2 is complete.
