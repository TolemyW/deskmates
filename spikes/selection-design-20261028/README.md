# Selection design requirements — 2026-10-28

Local fixture-only work in `codex/page-experience-polish`; no production or model
calls, deployment, commit or remote CI run.

- Requirements: `packages/ui/docs/selection-and-navigation.md`, linked from AGENTS.
- Audit/debt: `packages/web/docs/selection-design-audit.md` and feature-owned
  `design-exceptions.json` files (15 native dropdowns remaining).
- Costs mode/date choices and Files type/view choices use shared ChoiceGroup.
- Retired ad-hoc CSS recipes are removed and guarded against reintroduction.
- The browser matrix additionally compares actual cross-page ChoiceGroup styles.
- Local Web/UI/CI-script tests: 274 files, 1,951 tests passed.
- Root typecheck, lint, docs consistency, UI library, web and studio builds passed.
- `costs.png` and `files.png` show the final preview at port 5181.

The first expanded run observed a reset font fixture during concurrent source
editing: ten states measured 36px control height instead of the expected 72px.
The final test server disables file watching and HMR to isolate the run from
editing; font/geometry/style assertions are unchanged.

Final browser run exited 0: **4,000 layout states, 20 keyboard checks, zero failures**.
The negative-control grid defect was detected. `layout.json` retains the result.
