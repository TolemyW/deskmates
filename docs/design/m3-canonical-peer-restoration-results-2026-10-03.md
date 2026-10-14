# M3 canonical rules: real SDK own/peer restoration

Date: 2026-10-03 (Asia/Taipei). Working tree based on main `1109ec7`.
Status: selected ADR-0011 A5 / UX-01 mechanics verified. Full M3 not accepted.
No production logic, image, knob, commit, tag or deployment changed.

## Coverage gap and final check

ADR-0011 A5's verification row requires a run to modify both its own and another
bot's rules, an audit event, and subsequent canonical restoration for both.
`acceptance/m3-canonical-restoration.container.test.ts` initially tested only
own SOUL.md/MEMORY.md edits. Its new second case covers two bots in the same
workspace. Both receive different canonical SOUL instructions and nonempty,
different human-memory notes through the operator APIs.

Actual SDK processes, served by the local scripted fake Anthropic endpoint,
initialize the physical files. One actual SDK Bash call writes the same synthetic
mutation into all four files. Direct reads prove the writes occurred; the
writing run's ledger contains four `rule_file_modified` events with the exact
paths. Peer records say peer_file_changed_during_run and restoredOnNextRun false:
this is an observation, not attribution or a promise about an unmigrated peer.
No bot-level file access control is introduced.

Each bot's next SDK run reads its own files with Bash, in the same respective
SDK session as before. The direct bytes match the original canonical copies,
including both human-memory notes. Actual SDK tool-result events contain each
bot's own canonical rule, and the recorded model requests carry the respective
rule in the system prompt. Operator SOUL API values remain unchanged. The file
copy is the guarantee; this does not claim an access boundary or model obedience.

## Bound invocation and evidence

The final fresh invocation is
`/home/owner/agent_workspace/deskmates-reusable-canonical-peers-20261003-02`
on Testbox, systemd user unit `deskmates-canonical-peers-20261003-02.service`,
invocation `0cb802a0a5b14fc28149a0da4973b1a9`.
Helper archive SHA256:
`2e18d6b4a541c6cc4897da1c396cc2a8ee1b0ecfccd4a3e893784b30d6e7141e`.
It verifies all **939** source hashes of the frozen 5b75f541 candidate, applies
only the declared canonical acceptance and current ledger-support overlays,
records compiled input hashes, and reuses on-host dependencies. Relevant current
canonical/context/scheduler/protocol/lockfile source hashes match that parent
(`work-01/relevant-production-binding.json`). The same workspace image is
`sha256:c25d2707784381921e11569364770e132e7272baeb0bb3ca8d309b7a631f1061`.
This binding does not assert the unrelated newer Web repair is in the old parent.

The host heavy-test lock, 1200-second unit/1000-second child limit, exact resource
ownership journal and final cleanup bound this one file invocation. Real-model
environment keys are removed; the test explicitly starts its synthetic upstream.
No .env, private key, credential, Git history or node_modules was transferred.

Final result, completed 2026-10-02 at 16:40:34 UTC:

- **2 T2 cases pass**, zero failure/skip; Vitest success true, child exit 0.
- **9 support regressions pass**; all overlays reverify after execution.
- **7 SDK runs succeed** across **3 SDK sessions**, confirmed from the retained
  SQLite ledger. All usage is from the scripted fake endpoint's estimates, not
  real model usage or vendor billing. Both stored human-memory notes survive.
- **One complete ledger snapshot saved** before teardown; no missing snapshots.
  It remains private on the authorized host. Its hash and selected inspection
  facts are in the receipt, rather than downloading the SQLite database.
- **6 exact resource identities independently inspect absent** (container,
  workspace network and volumes). Systemd is inactive/dead, MainPID 0,
  ExecMainStatus 0. Stable services/data were not selected for cleanup.
- Local acceptance/backend typecheck, lint, diff whitespace check and the
  **11** canonical-file/T2-list contract tests pass.

The ledger contains eight rule-file observations across all seven runs: six from
the two controlled mutation phases, plus two peer-change observations while the
other bot legitimately restores its canonical files. A peer observation does not
prove which process wrote the file; the test asserts the four controlled mutation
records before starting concurrent restoration. Do not report all eight as
malicious or self-authored changes.

Selected receipt archive SHA256:
`0eaef3d4a53001776c244daa7014b81eb809a9536408d5aa3fb8b2568e7a45a9`.
All downloaded file hashes match its receipt inventory; local raw material is
ignored under `spikes/m3-canonical-peers-20261003/work-02/receipt`.

## Retained prior observation and limits

`deskmates-reusable-canonical-peers-20261003-01` separately passed both cases with
the original default MEMORY exports: six SDK runs/three sessions, one saved
ledger, six exact resources absent. Its helper archive is
`5a078442c666fe5838338252e6a62c9177edc6aa1a06d06de5fb295160582879`,
invocation `6a46315253594ee8b1f10460ae4f5bf5`, selected receipt archive
`9f65b7fc067e02fd5187b1957f22c2c9e151fba1b6bde10fd972f926f9a5155f`.
The final revision strengthened the oracle with distinct human notes and an
additional SDK initialization; it was not a retry selected after a failure.
The first runner's stale oneFullT2Invocation metadata name is preserved; its
command/reservation/report always select one file. Later source correctly names
it oneScopedT2Invocation. One post-run SQL inspection failed because shell
quoting removed a string literal; a parameterized readonly query corrected it,
without rerunning tests or changing the retained database.

These checks prove rule-file restoration mechanics with the actual SDK, not
configured-model retention, poison resistance or statistically valid memory
improvement. They do not close the retained full-T2 screenshot failure, replace
other adopted UX flows, or supply missing WABA configuration/model authorization.
The scope remains the full matrix in `m3-closeout-evidence-matrix-2026-10-03.md`.
