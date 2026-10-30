# Native desktop integration: scripted live acceptance

Date: 2026-10-19
Issue: #33; ADR-0048 decisions 3–11 and amendment 1
Lab material: **2026-10-19 — Native desktop Linux container acceptance**

## Scope

The optional local-only variant was built from the exact v0.7.6 workspace image
`sha256:91fe465705fbb425f6c12ac1feae6296921be565e8c483e47e2f60e8f84ad996`.
The retained LCU 0.11.3 and application 26.915.31945 inputs matched `pins.env`.
The resulting image was `sha256:4d92556286540993f5d9970d9a659ea4a8486383956834116c228e96d360061c`.
No registry push, default-image change or deployment was performed.

Docker 26.1.4 ran the real desktop proxy and LCU on Linux. The native form used
a separate test-only GTK derivative, never installed in the production variant.
A scripted MCP client replaced model planning. Gateway contention used two live
run-token routes and a fake run provider; the final egress case used a real
DockerProvider workspace, internal network and managed proxy. No model was called.

## Executable results

`acceptance/desktop-tools.container.test.ts`: **10 passed**, 46.89 seconds in the
final relay-filter rerun (2026-10-19 16:36:07 +08:00). The earlier 47.14-second
run remains retained. Each container was identified explicitly and removed by
its owning test.

| Case | Observed result |
|---|---|
| Image contract | Capability label present; no additional privilege over the base. |
| Upstream contract | Initialization instructions preserved; only `js` and `js_reset` exposed. |
| Output handling | Untrusted UI text wrapped; native-window screenshot retained its media type. |
| Cancellation | A cancelled call terminated LCU; the next session received the rediscovery notice. |
| Input reader | Real XTEST key, button and relative-motion events reached the raw-event reader. |
| Human takeover | A held workspace dispatched no call; a new takeover epoch interrupted an in-flight call. |
| Shared-screen leases | Two focus-free calls overlapped. Exclusive input excluded the peer and refused a browser acquire. |
| Per-call input ledger | Overlapping read-only calls recorded zero input; exclusive XTEST input recorded positive counts and no key codes. |
| Native task | The real GTK entry received `Deskmates native verification 中文 ✅`, Save was clicked, and an independent filesystem read matched the exact UTF-8 bytes. The saved-window screenshot was visually inspected. |
| Network boundary | A request issued by the actual LCU kernel to a private address was refused with HTTP 403 at the managed proxy. The workspace had exactly one internal network. |

Review follow-up: the test-only CONNECT tunnel now terminates at the same local
HTTP relay listener, so requests inside the tunnel cross its path filter before
the Gateway's run-token authentication. The existing coordination case sends
`GET /api/workspaces` inside CONNECT with a valid synthetic operator bearer and
asserts HTTP 403; the ten-case count is unchanged. Valid desktop-lock/event
requests continue to reach the test Gateway with their run-token headers.
This corrects the test relay, with no product or stable-service change.

The new raw log is retained separately as `desktop-t2-relay.log`, SHA-256
`d126caa9a59199bcf538f2732905621f219e3adbafc7a7bf32c94ac0ab3e65be`.
The rerun test file's SHA-256 is
`1ce5a8fdfb19ad41bfa51e64c7e0d3b4e071e95d9d70819758eb576fb68a83f9`.
It used the same base, desktop and proxy images, plus GTK fixture derivative
`sha256:190e410b2f74d8db39b8b8eb0a4d14146224d81d392f2b9a382c0abe546c350b`.
Acceptance typecheck and Biome checks passed after the relay change.

Two runtime defects were corrected: the pinned LCU starts without a `mcp`
subcommand, and `xinput test-xi2` must omit `--root` (which returned `BadAccess`)
and use line-buffered stdout. The measurement script now supplies the base
entrypoint's synthetic VNC/proxy prerequisites and fails when startup exits.

## Single-run measurement

| Quantity | Base | Desktop | Difference |
|---|---:|---:|---:|
| Docker image bytes | 3,459,345,293 | 5,505,927,775 | +2,046,582,482 |
| Gzipped `docker save` bytes | 1,230,652,790 | 2,267,700,410 | +1,037,047,620 |
| Time to healthy | 10.5 s | 10.5 s | 0.0 s |
| Idle memory after 30 s | 231,630,438 B | 227,331,276 B | −4,299,162 B |

The bounded active-doctor observation was 234,042,163 bytes. These are individual
observations, not distributions or a representative native-task peak. Gzipped
Docker archives are not registry-compressed layer sizes; archive inputs in lower
layers remain part of the image despite being removed from its final filesystem.

## Limits and retained evidence

The private lab contains the exact test, fixture, build and measurement logs,
measurement JSON and native saved-window screenshot. Maintained source includes
the executable T2 cases and test-only fixture. Local checks cover the image
contract, desktop hook, proxy and input recorder.

The normal accessibility-based native key method did not emit raw XTEST events
in this runtime. The per-call recording oracle therefore deliberately emits
XTEST in the LCU kernel; the native accessibility journey has its separate saved
byte oracle. This does not prove that every upstream input API emits raw events.
It also does not prove model-planned task success or a strategy improvement.
Real-model visual acceptance, paired strategy evaluation and redistribution
approval remain open. The optional image stays local-only.
