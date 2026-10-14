# B4 and B5 parallel development

Date: 2026-09-23. Base: `cbac38f`. Branch: `codex/m2-b4-b5-20260923`.
Status: B4 implementation and B5 knowledge/memory increment implemented; full acceptance and
B5 execution features remain pending. See [development results](m2-b4-b5-development-results-2026-09-23.md)
and [test handoff](../runbooks/m2-b4-b5-test-handoff-2026-09-23.md).

The user requested concurrent development and explicitly moved long verification to a
separate testing agent. The B1–B3 checkout is frozen for that handoff; this branch is a
separate worktree. No active application, shared image or test resource is changed.

## Dependencies and ownership

B4 and B5 can proceed independently once shared contracts are agreed. B5 uses the
existing B3 messaging/browser interfaces; completion of the long B1–B3 model campaign
is not a development prerequisite. Knowledge operator endpoints inherit B4 authentication
when integrated. Neither batch needs to wait for the other's UI or model evaluation.

| Workstream | Owner | Scope |
| --- | --- | --- |
| B4 operator boundary | Sol-medium subagent | Required operator credential, separate operator/sandbox listeners over one shared runtime, web session-only credential handling, focused route/auth tests |
| B4 workspace boundary | Sol-medium subagent | Per-workspace network lifecycle, authenticated noVNC, fail-closed network egress proxy and updates, provider/image tests |
| B5 and integration | Integrator | Shared contracts, knowledge proposals/review/FTS5/read/export and model tools, memory management, Gateway/provider/UI integration; inventory vision/CLI execution requirements |

The ADR-0006 decisions are activated for implementation without changing their intended
boundary. Network egress uses a managed forwarding proxy on an internal workspace
network; bots receive neither policy administration nor network capabilities. The proxy
is infrastructure. Workspaces still intentionally share state among their own bots.
HTTP(S) allowlisted egress, DNS behavior, host-Gateway exception and unsupported protocols
must be documented precisely. Auth, network and noVNC changes are integrated together;
individual units do not establish an accepted separate trust domain.

B5 follows design v0.3 section 3.6: reviewed team knowledge belongs to the Gateway,
markdown content plus SQLite FTS5; pending proposals are not bot-readable knowledge.
Run provenance is assigned by the authenticated server. The knowledge base is intentionally
shared after operator publication; it is not an implicit bridge for raw workspace files.
Memory read/edit/export remains operator-controlled, with bot memory a soft convention
inside a workspace. Vision fallback and CLI changes must preserve existing approval,
egress, target and takeover rules and remain separately identified strategy changes.

## Integration contract

- `SandboxSpec.egressAllowlist` is mandatory; empty denies external egress.
- `SandboxHandle.novncPassword` is in-memory only. Gateway generates the password;
  provider recovers it from the managed container on attach; never serialize it in DB,
  SSE or ordinary workspace responses. Only authenticated takeover can disclose it.
- `SandboxProvider.updateEgress(handle, allowlist)` applies a policy replacement and
  fails closed; Gateway synchronizes edits with the stored workspace policy.
- One Gateway services object owns DB/scheduler/cron. Separate listeners do not duplicate
  scheduling. Only explicit test helpers may combine route families, with auth retained.
- Reserve migration `0012` for knowledge; contracts and shared wiring belong to integrator.
- Worktree dependencies are local copies; agents do not modify the frozen B1–B3 checkout.

## Verification boundary

During development, run affected deterministic tests and type checks. Do not launch
Docker, rebuild images, call a model, run K5, or expand into a benchmark campaign.
Record concrete outstanding T2/T3/security/strategy checks in a test handoff. In particular,
no separate trust-domain claim is made until network/noVNC/credential isolation checks
pass. No general strategy improvement is claimed from a feature implementation.

Report implemented, locally verified, deferred, merged and deployed separately. Remaining
vision/CLI or other subitems must be listed explicitly if they are not delivered in this
increment. Keep independent development moving while another agent handles acceptance.
