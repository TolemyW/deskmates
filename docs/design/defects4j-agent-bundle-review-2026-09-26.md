# Defects4J QA agent-visible source projection review

Date: 2026-09-26. This is a source-only audit for `QA-D4J-LANG-1` and
`QA-D4J-CLI-1`, not a Java reference-control result, Deskmates workspace run or
model attempt. Both rows remain `needs_adaptation`.

The pinned public `defects4j-repos-v3.zip` is 631,727,844 bytes, SHA-256
`d7386b2f0fd0cfbb3e170daa0c73c24f022f8d4991339c55181d91d67d92a6b3`.
Only its `commons-lang.git` and `commons-cli.git` bare repositories were
extracted for inspection. [The projection script](../../spikes/reusable-tasks/defects4j/agent-bundle/prepare.py)
checks that ZIP and the pinned issue SHA-256, resolves the exact buggy commit
and tree, makes a raw Git archive, and compares every projected file's Git
blob ID and mode with the buggy tree. Its [pin manifest](../../spikes/reusable-tasks/defects4j/agent-bundle/projection-pins.json)
records the two outputs. It creates `work/project` plus `work/agent-issue.md`;
only `work` may be mounted in a bot workspace. Its `private` receipt stays
evaluator-side. No `.git` history, official trigger record, source patch,
reference test, generated `defects4j.build.properties`, `failing_tests` or
`all_tests` enters `work`. The script does not remove tests merely because
their names resemble a benchmark trigger.

| Case | Raw buggy provenance and preserved tests | Fixed-only evidence excluded by raw projection |
| --- | --- | --- |
| Lang-1 | Commit `396afc3e4693cfee182efe582455f2d97058c068`, tree `34e33cca607f33ffcf8661e3a6c4b7fc5aca9701`; 302 source files. The legitimate buggy `src/test/java/org/apache/commons/lang3/math/NumberUtilsTest.java` remains (blob `56b0597e768fdf3a25251f03094f2eb07dac1c88`). | Fixed commit changes that file to blob `bdd2a242e8b1b1dee2a43c14f91ff953a7dbd4a4`, adding `TestLang747` and its `0x80000000` assertion. That method is absent from the projected buggy file. |
| Cli-1 | Commit `8f46f467a33ace44ccd9f394910940b6c48a3827`, tree `54a885ce716c0df19c7187ed343f98390a47a27d`; 90 source files. Its 17 preexisting Java test files remain. | `src/test/org/apache/commons/cli/bug/BugCLI13Test.java` does not exist in the buggy tree; the fixed commit adds it (blob `7e63dfa023b295d242017d94d89e320327d157b6`). It is absent from the projection. |

Both local source/hash projections passed. The Lang raw archive SHA-256 is
`e1b6c7fa0a8528a19a068f40d26c73dbc0a29f4fddf35f5df0cb051d354844d7`;
the Cli archive SHA-256 is
`aa89b2d263aa843df8a5d9a3366dfc62088c38c232025934ec2f2e476b714845`.
Lang retained 128 Java test files; Cli retained 17. A follow-up inventory found
no forbidden metadata paths in either `work` tree. Private local outputs are
`/private/tmp/deskmates-qa-agent-bundle-lang-20260926/` and
`/private/tmp/deskmates-qa-agent-bundle-cli-20260926/`; their private receipt
SHA-256 values are respectively
`b0356500d310485a65cb6779786a69e8acc7b9586f6b9b8da6adac456a261368`
and `fd785e23856642211e03118c6e9432981e68abf42ca9b6c54b6b554a25bebfb1`.
The projection script SHA-256 is
`5b527ee384162a20d8b29e4c263616ba9e45b149eb4529058a5a7f6f6ab86a2f`.

This differs intentionally from Defects4J's official private `1b` checkout.
Pinned `framework/core/Project.pm` `checkout_vid` starts at `1f`, applies the
source patch to synthesize `1b`, calls `fix_tests`, writes version properties,
and creates local Git commits/tags. Consequently its `1b` tree can carry
fixed-revision tests and evaluator trigger metadata even though production
source is buggy. That checkout remains appropriate for private reference
controls; its bytes must not be treated as the blind agent starting state.
If a future agent adapter needs Git, it can initialize a fresh single trusted
baseline commit from `work/project` inside the isolated workspace, without
shipping the official history. That step is not yet implemented or tested.

Still required: independent remote Java compile/test behavior on these raw
buggy source trees with the adapted dependency image, byte comparison against
any official `1b` checkout once available, a vetted agent runtime with
offline build dependencies, leak check of its complete mounts/image, and a
grader that replays only agent-authored test changes into private buggy/fixed
controls. No QA reference controls or model calls were performed here.
