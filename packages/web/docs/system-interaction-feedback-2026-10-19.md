# System interaction feedback (2026-10-19)

The operator's ten browser annotations cover Computer, Costs, Integrations, Vault and
Internal network. This is a presentation change; the Gateway's roles, approvals,
credential contracts and network policy retain their existing behaviour.

| Comment | Result |
| --- | --- |
| 1 | Menu pages use a shared outer inset: 32px on desktop and 16px on narrow screens, with the same top padding. |
| 2 | The host-resource table sizes columns automatically above readable minimum widths and scrolls inside its existing keyboard-accessible table region. Long resource and workspace identifiers wrap across readable lines. |
| 3 | A selected network profile's optional end date uses a compact date input, aligned with its label; narrow layouts can wrap the pair. |
| 4 | Vault opens as a credential list with an Add action. Creation and each entry's management are dialogs. A short shared-workspace notice and the current approval mode stay visible; About contains the full boundary and fill limitations. |
| 5 | Channels show their title and observed status. Selecting a row opens its existing connection, recovery, account, capability and blocklist workflows in a dialog. Multi-connection status never claims all accounts are connected when one is not. |
| 6 | Pricing details open from a small text action inside the total tile, rather than occupying a second text panel. |
| 7 | Costs removes the generic introduction and repeated scope/budget explanations. Estimates, unknown prices, partial measurements and uncertain attribution remain identified. |
| 8 | The workspace retirement controls sit in the same page column, separated below the settings. Consequences remain in the confirmation dialog. |
| 9 | The egress editor's Save action aligns to the bottom right of its form. |
| 10 | The navigation group is named **System**, with noun labels in all five locales. Its internal group identifier remains `operate`. |

Dialog controls retain their role gates and return focus to the opening control.
Unsubmitted Vault values and channel tokens are discarded when their dialogs close;
values are still cleared after a refused submission. Saving a Vault value does not
claim that a sign-in succeeded. Approve all retains its explicit warning.

## Verification

- Typecheck and the web production build passed.
- The affected feature and navigation tests passed: 30 files, 176 tests. The final
  Vault refinement also passed its 18 feature/API/route tests; the final Costs
  refinement passed its 41 tests.
- Feature-scoped Biome, `docs:check` and whitespace checks passed. Root lint
  passed once; its final rerun found a formatting change in the concurrently edited
  `acceptance/m4-vault-browser.container.test.ts`, outside this UI change.
- The local browser check is `spikes/operate-ui/verify.mjs`. It reuses the existing
  fingerprint renderer with feature-owned scenarios, at 1224, 920 and 390 pixels.
  It asserts heading insets, document overflow, readable resource-column width and
  compact date-input width/alignment, and captures the five pages plus Vault Add
  and channel setup. All 21 final light-theme states passed, with no browser errors;
  artifacts are in `/tmp/deskmates-operate-qa-final`, including `verification.json`.
  Host inventory and the channel manifest are declared synthetic
  fixtures; it sends no provider requests, uses no real secrets and calls no model.

Run the browser check with an installed Playwright package:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright node spikes/operate-ui/verify.mjs /tmp/deskmates-system-ui
```

The output contains screenshots, DOM/computed-style records and a manifest. This is
local UI evidence, not a deployment, live credential-use check or milestone gate.

The broad T0/T1 run was stopped after three tests exceeded their default five-second
limits. Sequential retries with the same limits also timed out: OIDC sign-in start
storage bounds (`gateway/src/auth/oidc.test.ts`), multi-range file streaming
(`gateway/src/api/file-routes.test.ts`) and the offline web-search campaign
(`evals/web-search/dry-run.test.ts`). Those files are outside this UI change; the
cause of the timeouts is not established. This is not a clean whole-repository
pass and the change has not been deployed.

## Isolated submission

The submission branch `codex/system-ui-feedback` starts at private `main`
`94992a6639454c0b2142a7638b0f5ddc69aa548c` and contains only this feature's
40 files. Root typecheck, lint, docs consistency and the production web build
pass on that isolated tree. The 30 affected test files are rerun there with the
installed dependencies shared from the development checkout; a temporary, ignored
Vitest config permits Vite to read that dependency directory's real path. No test
assertions, time limits or product source are changed for that setup. The PR stays
a draft pending a clean full T0/T1 gate; the earlier broad-run limitations above
are retained.
