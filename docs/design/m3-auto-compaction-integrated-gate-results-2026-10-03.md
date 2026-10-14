# M3 integrated regression after automatic-compaction archive repair

Date: 2026-10-03 Asia/Taipei. One frozen deterministic gate passes. Full M3
acceptance remains open. No real model campaign, commit, tag or deployment.

## Candidate and execution

HEAD `1109ec784d6493b39ccfbde605484f4feef6bc98` plus 960 explicitly inventoried
working-tree files. Source manifest SHA-256:
`a786a38c72b3dc4dec8d221a13ccca3b42b071b110287a78c7e36e50c61c9bbf`.
Source archive: `cf952c20c023a06cc33269f132edeaef74eb3b993fc93f7d1b6db25c889d3b3f`.
Outer transfer archive: `aab45a156ab1ee1b140c84b61cc091e38119bed51ec2fe64136a0a927793e938`.
Credentials, actual .env files, keys, Git history, node_modules and unrelated
scratch evidence are excluded. Dependencies are copied only on-host.

Isolated Testbox root:
`/home/owner/agent_workspace/deskmates-reusable-auto-compaction-gate-20261003-a786a38c`.
Detached unit `deskmates-auto-compaction-gate-20261003-a786a38c.service`, invocation
`6b072e932cbc431683f5a379b3727f95`. The shared heavy-test lock is held for all
build/test stages. One full T2 invocation is reserved, two workers, 1200-second
command bound, 2700-second unit bound. No retries, browser overlays, DEBUG,
experimental driver flags, changed capture timeouts or strategy settings.

The runner verifies all source hashes before/after build and after tests.
Relative to the earlier 17cc1157 candidate, exactly four image source files
change: PreCompact hook and runOnce wiring, plus their two unit test files.
Contracts/connector/golden compiled inputs match their prior bindings. A fresh
workspace app layer is built offline with Docker build network none against
unchanged cached base `sha256:bffdc561d23361c6d199f62981b7543cc55f476bc28ef505da16207f700a61f5`.
No moving image aliases are changed.

New amd64 workspace tag `deskmates/workspace:amd64-6ab62bc99450`, ID
`sha256:f59d621f4199ce3b4a3564e5c037d847e9c6a0cc3ad4030252bdfc9c43b7dfa0`.
Egress/golden/connector/PostgreSQL images are reused only after unchanged source,
compiled input and exact ID verification. Stable services and other work remain
untouched; cleanup selects only this invocation's recorded exact identities.

## Results and independent audit

All stages exit zero: backend/acceptance typecheck, Web typecheck, lint, complete
T0/T1, all workspace builds, offline workspace image build and full T2.

- T0/T1: **2468 pass, zero fail/skip**.
- T2: **90 pass, zero fail, one opt-in real-model SDK-shape skip**, 28 files;
  358.75 seconds. One invocation, with original capture bounds.
- Twenty stack ledger backups all saved. Independent read-only integrity/FK
  checks pass; 59 run rows and 47 usage rows retained. These are fixture runs
  and synthetic usage, not real model spend or domain acceptance evidence.
- All 184 exact owned container/network/volume identities independently absent.
  Unit inactive/dead, MainPID 0, ExecMainStatus 0. No source mismatch among 960
  frozen files on the host.

The automatic-compaction test also passes here, on the separately built amd64
image: run `run_6acd8eea6fc94ad78bd0a50d4f5cefd5`, session
`3cd8c27c-adb0-4226-96ff-70b925cde40a`. Its 110923-character archive has twenty
JSONL records and the correlated original successful Bash tool result. An
independent collector verifies the exact prefix and tool/result association.
Archive SHA-256 `70958ea8faedf557cc098374ea18fffc24dfdc9c6d18cd3b7293419044bd1135`;
final transcript `560e2a7bc302dd3757d998cfd2841878f57579dfdb0fd212b8a905b254eefe9c`.
This confirms the selected production archive repair on both local arm64 and
Testbox amd64, without treating the scripted summary as a recall measurement.

Raw ledgers remain on Testbox. Twenty-four selected files are downloaded and
verified against their own hash inventory under ignored
`spikes/m3-auto-compaction-gate-20261003/work-01/receipt`.
Selected receipt archive SHA-256:
`3f93f34f8fe5f7ab5272572e2b762eb46a8ced17ee48322e82c03c4033f12df8`.
Independent audit:
`61c80de78920acc34e47514f18e5ec21c1cc88690d4111fa8cf555e351e904aa`.
Image source/compiled binding:
`d7a08210a5132766cf416b955149601af039ffafb800fa666d44808999adac05`.
T2 JSON report:
`af8f8f967c37d780367517dae77ac1f33c10b9534cd32406caa4b2507ff14498`.
Documentation finalization after this freeze does not change production or test
runtime inputs; this gate always identifies its exact original inventory.

## Remaining requirements

This is the new full deterministic gate for the changed hook, not full M3.
The known provisional per-turn SDK output issue remains to be repaired; a
separate actual SDK stream observation establishes the final event path without
changing production. Configured-model context/domain checks, powered ordered
memory/strategy trials and live WhatsApp still require their own evidence.
WABA exists but its configuration is not prepared. Automatic approval review
rejected the larger real-model campaign's scope, and the scope confirmation
remains unanswered; that campaign was not launched.

The older intermittent screenshot failure stays in its original receipt.
Passing this full gate does not establish its cause or a fix. Earlier fixture
failures and both archive races stay visible in
`m3-sdk-auto-compaction-results-2026-10-03.md`. No result is overwritten or
pooled across candidate revisions, and no strategy knob is adopted.
