# M3 real-container file preview browser results

Date: 2026-10-03 (Asia/Taipei). Selected UX-05 checks pass; browser download
landing remains unverified. Full M3 is not accepted. No production change,
commit, deployment, SDK execution or real-model call occurred in this check.

## Scope and bindings

The actual built React UI and production authenticated Gateway read a real
Colima Docker workspace through the production file route and sidecar file-read
command. Files and the human transcript entry were authored by the fixture;
this does not prove bot artifact generation or delivery. The isolated operator
listener used port 60228. The test token was synthetic.

Artifacts are under `spikes/m3-file-browser-20261003/work-01/` (ignored), with
the repeatable fixture and protocol retained in the parent directory.

| Input or receipt | Exact binding |
| --- | --- |
| Fixture source SHA-256 | `4e54d56e041d6325c380dddb1e9290bb043c833009c3686c4ba8c3c55e18b8ec` |
| Workspace image | `sha256:7e76493462b0f9a8484ae421a0a8dbf2ecb23e71a00deefefab447c5232c6bfc` |
| Egress image | `sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f` |
| Web index SHA-256 | `a70e595eea07f6eea22ba38e5ac5315bf79de785f3e17394f70e13c773d58739` |
| Web main bundle | `index-dKYe5fwL.js`, SHA-256 `015f6dfc42cd8fc59ea690b388d60c2030d1ce880858303ee80d450ae224b5bb` |
| Terminal receipt SHA-256 | `e00a9eb22c375375dd0543cf548932a14cccfcd2c353323ecb3b81d95a435bc3` |

All 895 runtime source, compiled and Web input hashes remain unchanged at
shutdown. The app-layer image was rebuilt from current compiled sidecar and
contracts using an inspected cached ARM64 base. The first buildx invocation
could not write Docker's activity file outside writable roots; its failure log
is retained, and image absence was checked before correcting the build. The
successful offline legacy-builder invocation used a task-owned Docker config,
explicit image tag and `set -e`. It did not pull dependencies or replace the
existing `deskmates/workspace:dev` image alias.

## Observed checks

| Check | Actual result |
| --- | --- |
| Markdown V1 inert rendering | PRE contains literal script and link source; zero nested script/link elements, no execution marker |
| Current file contents | After fixture updates the file, Preview displays V2 without changing the original transcript |
| Bot-home CSV | Actual preview is `name,count` followed by `qa,7` |
| Binary/control bytes | Preview refuses, download control remains enabled |
| Invalid UTF-8 | Fatal decoder error displayed; no partial preview |
| 256 KiB + 1 byte | Preview limit error displayed; download remains available |
| 1 MiB + 1 byte | Server limit error displayed for preview and actual Download click |
| Missing file | Explicit no-such-file preview error |
| Symlink to /etc/passwd | Policy refusal before content reading; no private file content returned |
| Unsupported .bin | Preview is unavailable; Download remains enabled |
| Quoted path with spaces | Plain transcript text; no misleading partial-path control |
| Hide preview | Removes the rendered preview |
| Stopped workspace | Preview and Download both refuse with workspace-not-running; preview count zero |

`inert-proof.json`, the AX snapshots, `error-proof.json`,
`ui-extra-proof.json`, `stopped-proof.json` and `preview-and-errors.jpg` retain
the observations. One locator initially used the visible label `Download`
instead of the path-specific accessible name and matched nothing; inspection
of the current AX state corrected the locator without changing the product.

Independent HTTP reads returned status 200, `application/octet-stream`,
attachment filenames, `nosniff` and `no-store`. V2 Markdown is 66 bytes with
SHA-256 `85281f670b231f29befa7b0f382089f2f0145ba829136aec27f7999ee326b5ee`;
the 256-byte binary file matches the seeded SHA-256
`40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`.
These checks prove server bytes, not browser disk landing.

## Retained unknown and cleanup

One valid UI Download click for V2 was made while waiting for the in-app
browser's documented download event (15-second bound). The observer timed out;
no saved path was returned, and the UI/console showed no error. This remains
an unknown outcome, not a passing download and not a diagnosed product bug.
The native-app controller subsequently reported that the Mac was locked;
manual unlock was requested for a standard-browser landing check. No unlock
reply arrived during this bounded fixture, and the lock screen was not bypassed.
No successful download was inferred from the separate HTTP hash check.

The fixture exited zero, with zero runs and zero model calls. Its journal has
only the original two containers, one private network and three volumes; file
actions after stopping did not recreate resources. All six exact identities
are independently absent, SQLite integrity is `ok`, port 60228 refuses
connections, and the temporary browser tab is closed. The existing dev image
remains `sha256:aa84db26d060bdd8bbbe8d645cb29778adf6a9cefc62bb3e8e195ddfbe3f7956`.
No other service, shared network or image was removed.

Standalone strict fixture typechecking passes. Production inputs are unchanged
from the latest 2460-pass T0/T1 receipt; this spike did not repeat that suite or
claim a new full T2 run. The earlier frozen Testbox T2 gate remains separately
bound. Completing browser file landing is still required for UX-05 closeout.
