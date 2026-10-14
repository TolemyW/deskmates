# B4/B5 parallel development results

Date: 2026-09-23. Branch: `codex/m2-b4-b5-20260923`; base: `cbac38f`.
Implementation commit: `f6dc1b3`.
Status: B4 implementation and B5 knowledge/memory increment delivered for integration testing;
not full B4/B5 acceptance, not merged or deployed by this task.

## Implemented behavior

B4 activates ADR-0006 as one integrated boundary change. A required operator credential gates
all operator APIs and SSE. Production uses two listeners sharing exactly one Gateway runtime.
The UI holds the credential only in memory. Workspaces get individual internal networks,
password-protected noVNC, and a separate managed HTTP(S) proxy. Policy changes close existing
connections and must be acknowledged before the database policy is committed. Proxy restarts
begin deny-all rather than resurrecting a creation-time policy. Creation, attach, restart and
policy edits use a per-workspace lifecycle gate and read current database state after acquiring
it. Legacy network/password configurations fail attach rather than silently inheriting trust.

B5 adds reviewed shared knowledge. Bot proposals carry server-assigned source-run provenance
and remain absent from retrieval until human publication. Published versions are immutable
Markdown files beside the Gateway database; files and directory metadata are synced before
publishing the SQLite pointer and FTS5 index. Operator editing uses optimistic versions.
Search/read/propose SDK tools, top-five context references and their version attribution are
wired through the sidecar; reference content is entity-escaped untrusted data. The web screen
supports search, proposal review, editing and export without rendering arbitrary HTML.

Operator memory read/edit/clear/export uses a dedicated SDK-free helper and a SHA-256 version.
Writes hold a scheduler maintenance lease to prevent new runs or resumes during editing. The
helper bounds input/files, rejects linked/nonregular paths, writes an exclusive temporary file
and atomically replaces MEMORY.md. There is no persistent lock to strand after a killed helper.
Bot/manual file writes remain shared-workspace behavior, not a separate security boundary.

## Development validation

- Backend/acceptance typecheck and web typecheck passed.
- Root integration batch: 9 files, 93 cases passed.
- Affected Gateway route/lifecycle checks: 30 cases passed across the original run and the
  targeted rerun of 10 workspace cases after updating the expected new VNC environment field.
- Operator subagent checks: 14 config/auth, 7 routing/origin, and 56 web cases passed; these
  overlap some root cases and are not added to a unique total.
- Provider focused suite: 8 files, 71 cases passed after restart-deny-all and pending-DNS
  revocation fixes. Proxy reload invalidates the policy generation immediately and closes
  tracked sockets before asynchronous policy loading.
- Source formatting and diff checks passed before committing this increment.
- No Docker build/run, real model, T2/T3 campaign, K5, deployment or shared-image replacement.
  The frozen B1–B3 branch and active app remain untouched.

The read-only integration review found and prompted fixes for policy rollback on proxy restart,
policy/create races, memory/start races, stale persistent memory locks and Markdown publication
crash consistency. Review does not replace live enforcement testing.

## Explicit gaps and operational limits

B5 automatic vision fallback after two target lookup failures and governed CLI/script mode
remain development work. Existing `--caps vision` and preinstalled CLI do not count as those
features. Automatic memory-suggestion review, knowledge history/pagination and orphan-version
cleanup remain follow-ups. No retrieval quality improvement is claimed without paired evidence.

The egress proxy currently supports public HTTP:80 and HTTPS CONNECT:443 with checked DNS
addresses. Private upstream services, databases and other protocols need explicit further design
and implementation; the current branch cannot claim those scenarios are complete. The documented
`host.docker.internal` exception remains direct host access. A proxy restart fails closed until
the current policy is reapplied, which can cause availability loss. Those limits must be accepted
or resolved before a deployment relies on the new boundary.

The golden-site fixture uses the direct host exception, so it cannot prove proxy enforcement.
Old acceptance helpers using a combined listener or unauthenticated raw fetches also need
explicit fixture work. Do not weaken runtime auth or egress to accommodate them.

The next tester should use [the consolidated handoff](../runbooks/m2-b4-b5-test-handoff-2026-09-23.md).
B1–B3 has its own frozen test handoff. Integration and strategy acceptance are tracked separately
so independent development can continue.
