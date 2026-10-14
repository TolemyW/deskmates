# Reusable adapter source and failure-classification review

Date: 2026-09-26. Scope: the Astropy patch collector and isolated-Gateway
setup/origin helpers, plus the FRAMES five-page public-corpus exporter/server.
This is a source review with narrow offline regressions, **not** a current
Deskmates runtime or model evaluation.

| Boundary | Review result |
| --- | --- |
| Evaluator data | The Astropy agent bundle contains the pinned baseline and issue, while the official row, gold, hidden tests, native-artifact manifest and grader stay evaluator-side. The collector reads only `/work/astropy` from the identified workspace volume and writes its patch/receipt outside the bot mount. FRAMES export accepts exactly five pinned public article snapshots by filename, title, revision, URL, license and text hash; no private row/answer/source-to-case map is an input. Its server exposes an in-memory page allowlist, not a directory. Natural facts in the public articles are intentional. |
| Agent-controlled Git and paths | The collector discards every `.git` component from the agent tar, reconstructs a trusted repository from a SHA-256-pinned baseline archive, disables external Git configuration/hooks/fsmonitor, and then copies only the candidate worktree. Python's tar `data_filter` and a 512 MiB streaming limit guard extraction; prior synthetic controls exercised malicious `.git`, oversized tar, symlink traversal, added/modified/deleted files and invalid patches. A declared native dependency differing from its baseline hash now yields collection `unknown`, not a task violation or agent failure. |
| Origin and setup | The Gateway setup helper permits only an exact loopback HTTP operator URL with redirects refused, checks the private launch receipt, pinned image/source/issue and immediately records a partial workspace identity. It POSTs workspace, restart, bot and thread, never a thread message. It now queries the newly created bot's runs and thread messages and refuses a successful receipt unless both counts are zero. The origin helper reads a consistent, read-only SQLite snapshot, hashes rather than prints run config, and checks the terminal run against its thread/workspace and Docker volume/image. It does not prove absence of out-of-band volume writes. Neither helper has run against the current Gateway; the no-run invariant is a source-level contract until that run. |
| Failure classification | Collector and origin-helper exceptions now exit `3` with structured `outcome: unknown` and `agent_failure: false`, without leaking exception text or treating an altered native extension as misconduct. An external driver must preserve that category; it must not convert nonzero exit into a case failure. If native dependencies change, this collector stops before producing a patch; a separate safe collection route would be needed before independent grading. |
| Corpus HTTP paths | The server serves only `/`, `/search`, `/healthz` and `/page/<slug>` where the slug must occur in the five-item validated index. It never joins request paths to files. Titles, snippets and wikitext are HTML escaped. The previous isolated Chromium preflight checked exact HTML hashes, seven private-style 404s and zero external page requests. A fresh Testbox loopback check again matched a served page hash and returned 404 for seven private/traversal paths, including percent-encoded dot and slash forms. |

The fresh check ran on Testbox Linux from the already exported public corpus,
without Docker builds or model calls. The `server.py` SHA-256 was
`a0e9d0de2d0a0dbad2a4f92ca094b055289b04960e11ef06414b4c64c27a5fa2`.
The three revised Astropy helpers parsed successfully on Testbox; SHA-256
respectively: collector
`bc5886b60a15524c5f6aff812f853571544419fc74e509733b6d2d65186dc364`,
setup `f95eb29c240782e3aeab32313a90f1f00ed40d6c9b4aeb51b68b35587b3a1ddb`,
origin helper `4289cd023eca4958ea80dba50e3c42ea1bbf4ff361212df4759fbbc24416a422`.
Negative missing-input controls of the collector and origin helper both
returned exit 3 with `unknown` and `agent_failure: false`; no workspace or
model run was created by these checks. The transferred copies and check
context are under private Testbox path
`/home/owner/agent_workspace/deskmates-reusable-evals/astropy-13033-20260925/security-review-20260926/`.

Unverified: a current-revision isolated Gateway launch, its no-message/no-run
API invariant under real services, trusted Gateway-run-to-volume attribution,
post-agent collection, native-rebuild patch handling, independent grading of
an agent-authored patch, and Deskmates browser/citation behavior. The private
source transfer and first model budget await distinct owner decisions. The
FRAMES public corpus is a small curated fixture, not the live-web benchmark.
