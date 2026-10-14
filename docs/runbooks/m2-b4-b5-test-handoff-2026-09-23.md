# B4/B5 development and test handoff

Date: 2026-09-23. Development branch: `codex/m2-b4-b5-20260923`.
Base: `cbac38f` (frozen B1–B3 closeout handoff).

The implementation is in `.claude/worktrees/codex-m2-b4-b5-20260923`. Do not test by changing
or restarting the main checkout on ports 5173/8080, the frozen B1–B3 worktree, shared `:dev`
image tags, or containers/volumes belonging to another agent. Use an isolated test worktree,
unique image tags, temporary ports/database and test-created resources. The existing deployed
application has not acquired these changes. This document is a test assignment, not a pass report.

## Delivered scope and remaining development

| Area | Implemented | Still required |
| --- | --- | --- |
| Operator boundary | Required credential, separate sandbox/operator listeners sharing one runtime, authenticated API/SSE, in-memory UI credential, authenticated noVNC credential delivery | Real listener/reverse proxy/SSE/log and VNC verification |
| Workspace boundary | Internal per-workspace bridge, managed forwarding proxy, allowlist update acknowledgement, restart deny-all, DNS address pinning, noVNC password | Live Docker enforcement; direct host exception audit; private-service/non-HTTP design and support |
| Shared knowledge | Reviewed Markdown publication, SQLite FTS5, source-run attribution, search/read/propose tools, top-five context references, edit/export and review UI | Real model usage and independent strategy evaluation; history/pagination and cleanup are follow-ups |
| Bot memory | Read/edit/clear/export API/UI, version check, bounded helper, atomic replacement, scheduler exclusion during operator writes | Real image helper and interrupted-operation checks; dedicated suggestion-review workflow remains open |
| B5 execution | Existing MCP vision capability and preinstalled CLI remain available | Automatic two-failure vision transition, governed CLI/script mode and their tests are **not implemented** |

B4 is not accepted as a trust-domain boundary yet. B5 is not fully complete. Remaining live
checks do not block unrelated development, but must pass before claiming the corresponding
milestone accepted or deploying this as verified isolation.

## Development evidence (no model or Docker)

- Backend/acceptance TypeScript build and separate web TypeScript check passed.
- Root focused integration batch: 9 files / 93 tests passed (knowledge store/routes, memory
  routes/helper, lifecycle serialization, operator route walk, sidecar fake-SDK run path,
  knowledge UI and credential UI).
- Affected Gateway route/lifecycle batch: 30 cases across four files. The first run had one
  obsolete environment equality assertion after adding the VNC password; it was corrected to
  assert the password format. Its 10-case workspace suite passed on the targeted rerun; the
  other 20 cases passed on the original run. No product failure was suppressed.
- Operator subagent: config/auth 14, direct-message/browser-origin 7, web auth/client/SSE/
  takeover/thread/run/approval 56 cases passed. Some overlap with the root batch; do not sum
  these figures as distinct tests.
- Provider subagent: final package T0 suite passed (8 files / 71 cases), including restart
  deny-all and pending-DNS revocation.
- No Docker build/run, T2, real model T3, K5 or paired strategy comparison was executed.
- Full repository `npm test` was deliberately not run. Remaining direct HTTP clients in old
  acceptance fixtures may need operator credentials; do not bypass production auth to make
  old tests pass.

See also [operator handoff](m2-b4-operator-test-handoff-2026-09-23.md),
[provider README](../../packages/sandbox-docker/README.md), and
[proxy image instructions](../../images/egress/README.md).

## Prepare an isolated integration stack

1. Build distinct workspace and proxy image tags. The proxy build context is the repository
   root and Dockerfile is `images/egress/Dockerfile`; see its README. Set `WORKSPACE_IMAGE` and
   `EGRESS_PROXY_IMAGE` to those exact tags. Do not reuse the frozen B1–B3 runtime image.
2. Set a new random `GATEWAY_OPERATOR_TOKEN` (at least 32 bytes), private database path,
   distinct `GATEWAY_PORT`/`OPERATOR_PORT`, and matching Vite `OPERATOR_PORT`. Load model
   credentials through the existing ignored environment only if the test actually needs them.
3. Start the split production builders. `acceptance/support/start-stack.ts` currently uses an
   explicit authenticated combined test surface; it is **not evidence of listener separation**.
   Create a split-listener fixture for boundary tests rather than reusing its combined URL.
4. Build the proxy image before any provider T2. Legacy containers lacking the required
   network/password fail attach; do not migrate another agent's live workspace. Recreate only
   test-owned containers and preserve named volumes when testing migration.
5. The golden-site helper rewrites its address to `host.docker.internal:<ephemeral-port>`.
   Chromium bypasses the proxy for that host. A golden-site success can check browser behavior
   but cannot establish proxy enforcement. Use a separate controlled public-domain HTTP:80/
   HTTPS:443 fixture for that gate. Private addresses and other protocols/ports are currently
   refused through the proxy. Do not loosen production rules for a test fixture.

## Focused acceptance matrix

| ID | Test | Required evidence / pass condition |
| --- | --- | --- |
| B4-A | Operator boundary from host and each workspace | No credential/run credential cannot read or mutate `/api/*`; operator credential works only there; sandbox listener returns 404 for operator/webhook paths; operator listener cannot serve internal/model routes |
| B4-B | SSE, reconnect and logging | Authenticated reconnect works; missing token rejected; SSE query credential rejected on other endpoints; credentials absent from Gateway and reverse-proxy logs; web reload/disconnect clears session credential |
| B4-C | Two real workspaces | Direct sibling network and noVNC/CDP reachability blocked; legitimate Gateway/model path works; record actual Docker networks, image IDs and addresses |
| B4-D | Egress enforcement | Allowed public domain works; unlisted domain, IP literal, private/mixed DNS answer, rebinding, direct TCP and DNS bypass fail outside documented host exception; HTTP redirects remain checked on each destination |
| B4-E | Revocation and restart | Revoke during established CONNECT and pending DNS; existing sockets close and stale DNS cannot open a new connection; proxy process/daemon restart starts deny-all; current DB policy is reapplied explicitly; simultaneous create/restart/PATCH cannot resurrect old allowlist |
| B4-F | noVNC | Correct password works; no/wrong password fails RFB handshake; `vnc.html` loading alone is not proof; attach recovers password after Gateway restart; it appears only in authenticated takeover response/browser fragment, never DB/SSE/ordinary registry response |
| B4-G | Lifecycle and host exception | Attach/create/destroy remove only test-owned resources and preserve data volumes; rollback fails closed; record exactly which host services remain reachable through `host.docker.internal`; this implementation does not claim host firewall isolation |
| B5-A | Knowledge publish path | Model calls propose; draft absent from bot search/read; human approves; subsequent bot retrieves/reads same ID/version. Reject and duplicate review cannot publish; wrong run token cannot forge source attribution |
| B5-B | Knowledge recovery | Restart Gateway with same DB+knowledge directory; content/index match. Interrupted publication never exposes a partial version. Backup/restore both stores. Old immutable/orphan files are retained and must not be treated as published |
| B5-C | Operator memory | Real image read/edit/export/clear works; run cannot start/resume during edit; stale version returns conflict and preserves user edit; killed helper leaves no persistent edit lock; path/symlink/oversized/FIFO input refused; manual/bot file writers remain shared-workspace actors |
| B5-D | Knowledge injection and quality | Forged wrapper tags remain escaped; no draft content becomes an instruction. Record actual retrieved IDs/versions. Pair retrieval on/off independently from browser driver changes; evaluate multilingual/Chinese recall (FTS tokenization is not semantic search) |
| B5-E | Remaining execution development | After implementation: two matching target lookup failures trigger bounded screenshot/coordinate mode only for the run's verified tab; takeover/revoked egress suppress capture/action; CLI scripts preserve attribution/approval/lock and fallback on script failure |

Stop each case after a concrete product failure with the minimal run/events/network evidence.
Do not repeatedly run expensive model campaigns to explain a deterministic infrastructure fault.
Report environment/fixture limitations separately from product failures. Any framework behavior
change or retrieval/prompt/driver strategy change needs the measurement protocol before claiming
improvement; a successful demonstration is not that comparison.

## Result template

Record revision, image IDs, nonsecret configuration, test IDs and pass/fail/blocked, run IDs,
first relevant error, reproduction and cleanup inventory. Link raw output from a test-owned
artifact directory. Never attach operator/model credentials or unredacted private content.
