# M3 integrated regression after final per-response usage repair

Date: 2026-10-03 Asia/Taipei. The frozen deterministic code gates pass;
selected offline replay passes after a launcher correction. Full M3 remains
open. No real model campaign, commit, tag or deployment was performed.

## Candidate and execution

HEAD `1109ec784d6493b39ccfbde605484f4feef6bc98` plus 963 explicitly inventoried
working-tree files. Source manifest SHA-256:
`3530ec945754f03fd80a81e7268e89daebd4b88516686a305f105fe484cd4bf2`.
Source archive: `f16babf5938bc3fbc9700b1cc31b52ad88bf4bb61e622dde90602f3432a1c3da`.
Outer transfer archive: `d78c7cecc44120d61c85a2c2191d4a7e904d863ea6903335a24ef6d9cfadf91d`.
Actual credentials, .env files, keys, Git history, node_modules and unrelated
scratch data are excluded. Dependency reuse occurs only on-host.

Isolated Testbox root:
`/home/owner/agent_workspace/deskmates-reusable-stream-usage-gate-20261003-3530ec94`.
Detached unit `deskmates-stream-usage-gate-20261003-3530ec94.service`, invocation
`6f5132bd4f6f4c1ba4d1697ae6a6131d`. The shared heavy-test lock covers all stages.
Exactly one full T2 invocation uses two workers, a 1200-second command bound
and a 2700-second unit bound. Original browser capture bounds remain unchanged;
no diagnostic overlays, DEBUG, experimental driver flags or strategy settings.

All frozen source hashes match before/after build and after tests. Relative to
the a786a38c gate, exactly four image source files change: turn-usage and runOnce
production files and their unit tests. Unaffected source and compiled image
inputs are checked before reuse. The workspace app layer is rebuilt offline,
Docker network none, against the same cached base
`sha256:bffdc561d23361c6d199f62981b7543cc55f476bc28ef505da16207f700a61f5`.
New tag `deskmates/workspace:amd64-e896fb1adaba`, image ID
`sha256:81490be0a44d7a56f136f2572310d88621181d32bbf14cb6e0bd20453721181a`.
Stable services, other work and moving image aliases are untouched.

## Results and independent audit

Backend/acceptance and Web typecheck, lint, all workspace builds and the offline
workspace image build pass.

- Complete T0/T1: **2475 pass, zero fail/skip**, 241 files, 42.395 seconds.
- Complete T2: **90 pass, zero fail, one opt-in real-model SDK-shape skip**,
  28 files, 360.606 seconds. One invocation, no retry.
- Twenty stack ledgers are saved and pass independent read-only integrity/FK
  checks. They retain 59 run rows and 47 synthetic usage rows, not vendor spend.
- All 184 exact owned container/network/volume identities are independently
  absent. The unit is inactive/dead, MainPID 0, ExecMainStatus 0.
- All 963 frozen files match on the host. Before documentation finalization,
  all 963 also match the current local inputs; later documentation/helper edits
  are separate from this original source inventory.

The actual SDK automatic-compaction T2 succeeds on this new amd64 image:
run `run_7996d1029e7947cba23bf50d52cad421`, session
`325ea9e8-07fb-490c-83ed-6347269240c3`, one physical attempt. Two main response
ledger measurements independently match final proxy input/output/cache counts;
outputs are 26 and 59. Summarizer output 41 is a separate request. Final run
usage is synthetic input 228716, output 126, cache 0/0, cost unknown/null.

The archive is an exact final-transcript prefix, twenty JSONL records and
110923 UTF-16 code units (the Gateway's JS string length). Original Bash tool
and successful correlated result bytes are retained. Independent verification
checks the raw downloaded bytes, hashes, association and proxy/turn oracle.
Archive SHA-256 `a8e5b675172ad011ce995a67c137bd0359bd71ad89b94bba23bad98521737e53`;
transcript `f820caf2a55394c1100532f63cfc6f2a045b6f346e74689058a09997a9ebe340`.
The collector's initial Python Unicode-length assertion is corrected to compare
the documented JS UTF-16 units; no SDK/test rerun follows that audit correction.

## Retained replay launcher failure and recovery

The original last stage fails before replay execution: a transferred .ts helper
outside the repository's ESM package is interpreted as CJS, which rejects its
top-level await. Therefore `status.json` retains `decisionReplayPassed=false`;
the unit's exit zero alone is not a claim that every stage passed.

One offline recovery uses a byte-identical .mts copy with explicit ESM semantics.
The helper hash remains
`4f382ae773d7d560247fae12addcf2e2545bc35482e5becb400b0f5e09a640cb`.
It verifies source hashes and terminal unit state, acquires the shared lock,
replays the same exported operator trace, and exits zero. One local Bash decision
is identical across the compared policy dimensions; no unsupported/error result.
No SDK, model, task submission, image build or T2 retry occurs in this recovery.
The original status and failed log remain unchanged. A preliminary recovery
lookup discovers that spike helpers are outside the frozen source archive;
that preflight starts no replay/SDK. Future transfer helpers use .mts directly.

Recovery receipt SHA-256 is
`61eafe4fcc4c89c3fa604f719f65098ed71e2b997868761ef7fc8aa60e01601f`.
Artifacts have their own hash inventory under
`spikes/m3-stream-usage-gate-20261003/work-01/replay-recovery`. The decision result
is `b82fc3ea36186e9920400773ecf04d8fea549f947247c891cbc93e97249f9a70`;
trace source is `7672b55d8eb2ef16ce62d2817d2f4d259f91229e2f0de70f5bd60e2b451e55f6`.
This selected replay is not a model behavioral-distribution experiment.

Twenty-seven original selected receipts are independently hash-verified under
ignored `spikes/m3-stream-usage-gate-20261003/work-01/receipt`. Raw databases stay
on Testbox. Selected archive SHA-256:
`63de95b3c61b8a977f2ea01ca03ea571c448a6faa31848797fdfc28891872ebd`.
Independent audit: `d7cbe715a01e3a1c2632dd09c22a427edb0ae5d6a2be4778f8039e1115249044`.
Image binding: `94489a5bbe14ccfad0a7e79d8131884a13aa3f145761a697b26030296730234a`.
T2 report: `ad7b30d0efcd663acfa7e88ea652a87902c85dbed1c38a7e637747a22785496d`.
Proxy/turn oracle: `2169b6332243c4358515dbcb85099d494d852a7b77d5e08fcb65da2ccdacbd2e`.
Independent downloaded-proof verification:
`60ce001c31b00ddc28c176cddb1e849e4c06b34abaa25aed3251d364745b5e70`.

## Remaining requirements

The selected per-response repair now passes full deterministic integration on
its own fresh image. Configured-endpoint stream/usage/context fidelity, domain
tasks and powered ordered memory/strategy trials remain unverified. Main/nested
stream correlation has unit coverage, not an actual nested-agent acceptance.
The earlier screenshot failure remains without a proven cause or fix.

WhatsApp has an account but configuration is not prepared. Automatic approval
review rejected the larger real-model campaign because the earlier limited
waiver did not establish its expanded scope; scope confirmation is unanswered
and that campaign was not launched. These requirements remain in
`m3-closeout-evidence-matrix-2026-10-03.md`. No strategy knob is promoted.
