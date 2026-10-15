# Network profiles (ADR-0027 amendment 1, owner-decided 2026-10-14)

A network profile is a named, durable set of LAN grants that the root or a workspace Owner
defines once and a workspace's Admins select where it is needed, such as a "VendorDB test environment" for functional tests against
`http://10.20.30.24:23001`. Changes apply online: no Gateway, workspace or browser restart.

## Rules

A profile holds 1 to 64 rules:

- `{"kind": "subnet", "cidr": "10.20.30.0/24", "schemes": ["http"], "ports": [23001]}` admits
  IP-literal URLs inside a canonical RFC1918 IPv4 network.
- `{"kind": "host", "hostname": "console.vendordb.lan", "address": "10.20.36.35", "schemes":
  ["https"], "ports": [443]}` admits one exact DNS name, connected to its pinned address with no
  DNS lookup. HTTPS keeps normal hostname and certificate verification.

Schemes are a non-empty subset of `http` and `https`; ports are 1 to 16 integers. Wildcards,
IPv6, loopback, link-local and metadata, CGNAT, public and reserved addresses are rejected. A
profile and a selection may each carry `expiresAt`; a grant ends at the earlier one.

## Who does what (decision 12)

- The root (operator credential or protected account) creates, edits and deletes any profile. A
  root profile is available to every workspace.
- A person who is Owner of at least one workspace creates profiles too. Such a profile records
  its creator (`ownerUserId`) and is available in exactly the workspaces where that person is
  Owner now; only its creator and the root edit or delete it.
- An Admin or Owner of a workspace selects among the profiles available there
  (`GET /api/workspaces/:id/network` lists them as `available`). A selection already in place
  may be kept after its profile stops being available; the root may select any profile.
- Members, Guests, bots and run tokens define and select nothing.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/network-profiles` | Owner of any workspace | `{profiles, note, manageAll}`: the root sees every profile; an Owner the root's, their own and their co-Owners'; each with `editable` |
| `POST /api/network-profiles` | Owner of any workspace | create `{name, description?, rules, expiresAt?}`; an Owner's profile names them as `ownerUserId` |
| `PUT /api/network-profiles/:id` | root or creator | replace whole; `expectedRevision` makes a stale edit a 409 `stale_revision`; returns `{profile, publications}`; others 403 `profile_owner` |
| `DELETE /api/network-profiles/:id` | root or creator | delete and revoke in every selecting workspace; returns `{profile, publications}` |
| `GET /api/workspaces/:id/network` | Admin | `{trustedTest, selections, grants, openInternet, profilesOnOpenInternet, available}` |
| `PUT /api/workspaces/:id/network-profiles` | Admin | replace selections `{selections: [{profileId, expiresAt?}]}` among available or already selected profiles (others 404); returns `{selections, publication, network, note}` |
| `PUT /api/workspaces/:id/network-settings` | Admin | `{profilesOnOpenInternet}`; audited `workspace.network_settings_set`; returns `{network}` |
| `POST /api/workspaces/:id/network-preflight` | Admin | `{url}`: policy, route, DNS, TCP, TLS and HTTP layers, `failedLayer` |
| `GET /api/network-overlaps` | root | `{checked, networks, overlaps}`: LAN targets inside a Docker network |

An open-internet (`*`) workspace may select profiles while its switch `profilesOnOpenInternet` is
on, which is the default (decision 13). Such a workspace browses untrusted pages and reaches the
granted LAN targets, so keep production credentials out of it and point profiles at test
services. With the switch off, selecting a profile on a `*` workspace or setting `*` on a
workspace that selects one is refused with `reason: open_internet_with_network_profiles`, and
the switch cannot be turned off on a `*` workspace that still selects a profile.

## Screen

`#/network` (Operate → Network) is shown to the administrator account and to workspace Owners.
It creates profiles, edits the ones the caller may edit, selects them per workspace with an
optional per-selection expiry, sets the open-internet switch and runs the connectivity check for
one URL against the selected workspace. The overlap report appears for the root only. The
workspace detail page has a Network profiles section with the same selection, switch and check
for that workspace, for its Admins and Owners.

## Publication

The change is committed first, with its audit row and the profile's new `revision`. Each
affected workspace is then published under its policy lock with its allowlist and grants read
from the database at that moment, so a concurrent allowlist edit is never lost. A publication is
`applied` (the proxy reloaded), `unchanged` (same policy hash, no reload), `not_running` (no
sandbox; the next start carries the grants) or `failed` (the proxy did not acknowledge and was
stopped; the next sandbox use reattaches and pushes the durable policy). Each outcome is an
audit row `network_policy.publish`. A reload closes every existing external connection of that
workspace; workspaces that do not select the profile are not touched.

`EGRESS_PRIVATE_TARGETS` keeps working unchanged and is still read only at startup.

## Docker/LAN overlap (amendment 2)

A LAN address inside the subnet of a Docker network on the same daemon is routed by the host into
that bridge, never onto the LAN, and no grant changes that. The Gateway compares profile rules,
`EGRESS_PRIVATE_TARGETS` addresses and `NETWORK_LAN_CIDRS` (comma-separated IPv4 CIDRs of the LAN
the host reaches) with every Docker network's subnets: it logs one warning per overlap at startup,
lists them at `GET /api/network-overlaps` and on the screen, and the preflight fails such a target
at its `route` layer before probing. Nothing is refused or renumbered; move the Docker network
(`default-address-pools` in `daemon.json`, then recreate it) or the LAN service.

## Cached sandbox handles (amendment 2)

Before a cached handle is reused, the Docker provider checks the workspace container with
attach's rules: its own workspace network only, no direct host alias, its labels. A network
added by hand (say `docker network connect vendordb-demo-net …`) therefore fails at the next use:
the handle is dropped and attach refuses the container, as it would after a restart. Attach
validation is never relaxed; reach a Docker-only service through a supported path instead.

## Not done yet

Internal DNS for unpinned names, the opt-in browser CLI workflow (it keeps its public-origin
rule) and a Docker-only test-service adapter.
