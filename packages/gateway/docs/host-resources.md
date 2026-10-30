# Host resources: detect, show, repair, clean (ADR-0006 amendment 5)

Workspace containers, networks and volumes on the Docker host can outlive the database rows
that own them: networks a former product name left behind, the workspaces a failed T2 run
created for a temporary database, the runtime of an archived workspace. And Docker's default
address pools hold about 31 networks, one per workspace. The Gateway lists what the provider
owns, says why each leftover is flagged, offers one action per finding, and watches the pools.
Issue #14; decisions 11 to 15 of [ADR-0006](../../../docs/adr/0006-operator-api-auth-and-workspace-networks.md).

## What is listed

`SandboxProvider.listHostResources` (Docker: `DockerProvider`, test double: the testkit
`FakeSandboxProvider`) reads, with GET requests only:

- every container, network and volume labelled `deskmates.managed=true` with the workspace its
  `deskmates.workspace` label names; for a workspace container also the topology verdict
  `attach` would give (`network-topology.ts` `topologyProblem`) and the number of
  `deskmates-sidecar` processes running in it (`GET /containers/<id>/top`);
- networks of a former product name, matched by the provider's own naming rule with another
  prefix (`formerNameNetwork`): `<prefix>-net-<id>` labelled `<prefix>.managed=true` and
  `<prefix>.workspace=<id>`, or named after a Gateway workspace id (`ws_` and 32 hex digits)
  when it predates the labels, and `<prefix>-egress-outbound` labelled `<prefix>.managed=true`.
  No product name is written in the code;
- sizes where Docker reports them (a container's writable layer, `/system/df` for volumes) and
  creation times;
- `DefaultAddressPools` from `GET /info` (absent: Docker's documented defaults, fifteen /16 in
  172.17-172.31 and 192.168.0.0/16 in /20) and the IPv4 subnet of every network.

## How it is classified

`classifyHostResources` (contracts) groups the resources by workspace id and asks the database:

| Flag | Condition | Action |
|---|---|---|
| `orphan` | the id is not in `workspaces` (a T2 leftover, a purged row, another Gateway's) | Remove: workspace container, egress proxy, network, volumes, in that order |
| `archived` | the workspace is archived and resources of it remain | Remove of the runtime only; the volumes stay for a restore, and a purge from Trash deletes them. Volumes alone: no action |
| `topology_mismatch` | an active workspace's container fails the rule `attach` applies | Re-attach |
| `legacy_network` | a former-name network | Remove, only while no container is attached |

Everything else belongs to an active workspace with an accepted topology and is only counted
(`healthy`). An action is `blocked` while a run of this Gateway is live in the workspace or a
sidecar process runs in its container.

Pool headroom (`addressPoolHeadroom`) counts, per pool, the chunks of the pool's network size
that the daemon's subnets overlap; a subnet outside every pool counts against none. The status
is `exhausted` at no free chunk, `low` under a tenth of the capacity, else `ok`; `unknown` when
no pool parses.

## Routes

All three are the root's alone (`route-policies/host-resources.ts`); see the generated
[permission matrix](../../../docs/generated/permission-matrix.md).

| Route | Does |
|---|---|
| `GET /api/runtime/resources` | the `HostResourceReport`: `checked`, `findings`, `healthy`, `pool`; changes nothing |
| `POST /api/runtime/resources/remove` `{ findingId }` | Remove for that finding; answers the `HostResourceActionResult` with `removed` and the new report |
| `POST /api/runtime/resources/reattach` `{ findingId }` | Re-attach for that finding; answers `repaired` and, when not, the `problem` still left |

Before acting the Gateway lists and classifies again and acts only on a finding that is still
present and offers that action: 404 when it is gone, 400 for the other action, 409
`invalid_transition` / `reason: "run_live"` while a run is live (checked again under the
workspace's sandbox lifecycle gate). The provider checks every label again before each delete.
Each attempt, done or failed, is one `audit_events` row, `host_resource.remove` or
`host_resource.reattach`, target kind `host_resource`, target id the finding id; under the
workspace when the database knows it, else under the root's tenant with no workspace. A known
workspace's cached sandbox handle is dropped, so its next use attaches afresh.

Re-attach generalises the proxy re-pin `attach` already does: it disconnects the workspace
container and its proxy from every network that is not theirs, creates the workspace network if
it is missing, connects the container with its old aliases and the proxy with `egress-proxy` at
the address the workspace pins (without it when the daemon refuses that address), and inspects
again. Nothing is recreated. A container whose `HostConfig.NetworkMode` still names another
network, or whose pinned proxy address could not be restored, stays a mismatch, and the answer
says so; restarting the workspace's computer recreates its sandbox from the volumes.

## Startup and status

At start the Gateway runs the same report once, after the LAN overlap check, and warns:

- `Docker address pools low|exhausted: <free> of <capacity> networks free (...)` when the pools
  run low;
- `Host resources: <n> finding(s) (...)` when anything is flagged.

It never blocks startup. `GET /api/runtime` carries the last check's pool headroom as
`addressPools` (absent before the first check); polling it never calls Docker.

## Caveats

- Two Gateways on one daemon, such as the stable instance and a T2 run, see each other's
  workspaces as orphans. The sidecar-process check refuses a Remove while the other one runs
  something there; between its runs nothing can tell, so remove only what is known to be stale.
- The listing reads one inspect per workspace container and per listed network, and one
  `/system/df`; on a host with many volumes `df` takes a few seconds.

## Web

The Network page shows the report to the root under "Host resources": what (each container,
network and volume), which workspace or none, size, creation time, why it is flagged, and the
one action, disabled with the reason while it is refused; the pool line warns when the pools run
low (`packages/web/src/features/network/host-resources-section.tsx`). The demo has no Docker
daemon and shows the host as not checked.

## T2 cleanup

`acceptance/support/stop-stack.ts` removes every resource labelled with each workspace the stack
created, after the existing steps and also when `startStack` or `addWorkspace` failed half way.
`DESKMATES_T2_KEEP_WORKSPACE=1` keeps them for inspection and prints the ids it kept.

## Tests

- T0 contracts `host-resources.test.ts`: classification per flag and pool arithmetic.
- T0 sandbox-docker `network-topology.test.ts` (one case per topology flag, the former-name
  rule) and `host-resources.test.ts` (listing, delete order, Re-attach) against a stubbed
  Engine API.
- T1 `api/host-resource-routes.test.ts` with the testkit fake provider: the report, root only,
  both actions, the refusals and the audit rows, the startup warning and `GET /api/runtime`.
- T0 `acceptance/support/stop-stack-cleanup.test.ts`: the label sweep, the keep flag, a failed
  start.
- T2 `packages/sandbox-docker/src/host-resources.container.test.ts` (skips without Docker): an
  orphan's Remove leaves nothing labelled with its id; a container moved to a wrong network by
  hand is repaired by Re-attach and `attach` accepts it again.

Not verified here: the stable host's former-name networks and T2 leftovers listed and removed
through the UI with the live workspaces untouched, and the T2 file against a real daemon.
