# Preferences and workspace settings — 2026-10-22

The owner requested a single preference entry, explicit account editing and a redesigned
workspace-settings flow. This is a presentation amendment to the account and workspace UI
described by ADR-0022 amendment 3 and ADR-0034. Routes, storage scope, authorization, password
rotation, approval controls and destructive-action confirmations retain their existing contracts.

## Interaction decisions

- The sidebar sliders entry opens Preferences. Language, appearance and the Use/Tune switch
  are together there for every role and in expanded, compact and mobile navigation. The current
  mode remains visible on the expanded trigger. Opening preferences does not change mode or
  navigate away; closing returns focus. Language still saves to the account; theme and mode
  still save only in this browser. Account settings no longer duplicates these controls.
- Display name is a saved value with Change. Change opens and focuses its editor; Cancel
  discards changes; a failed save retains the input; successful save updates identity and
  returns to the saved-value view. The immutable login name stays distinct.
- Password starts with its capability explanation and Change password. The form exists only
  while editing. Cancel clears and closes it. A successful change adopts the rotated session,
  clears secrets and closes the editor. Validation failures remain editable, while transport or
  server attempts retain the existing secret-clearing rule. No password enters browser storage.
- Workspace selection and configuration are explicit separate actions. A directory row's name
  continues to open settings; Enter selects the workspace and opens Chats, and Settings opens
  its full-page configuration without changing the selected workspace. Current and archived
  states remain clear. Enter rechecks the authorized full row before selecting; an archived row
  or failed read keeps the current route and workspace. A response arriving after leaving the
  directory is ignored. Search, pinning, server pagination and returning to the same list remain.
- Workspace settings are organized into Basic, Team and approvals, Tools and network, and
  Lifecycle. Each section declares its own group beside its existing audience. Only visited
  groups mount; visited groups stay mounted while hidden, preserving unsaved inputs. Changing
  workspace resets this local editing context. Tune-only fields keep that visibility rule.
  There is no new global Save: each existing domain retains its own validation, feedback and
  confirmation, so saving a name cannot accidentally submit a network or approval-policy edit.
- The workspace search is one labelled search input with an inline icon. The toolbar and list
  adapt to narrow screens without stacking an input inside a second input-looking box. Settings
  headers identify the actual workspace, and the ID is available as secondary technical detail.

## Verification

The local gate passed: typecheck, lint, documentation consistency, all 886 T0/T1 files
(8,322 tests), and the web production build. The build retains its existing large-chunk warning.
Updated UI tooling follows the shared preference entry and native theme selector. The native
language and appearance controls avoid a nested popup/focus conflict inside the modal.

Regression coverage includes explicit edit/cancel/save/error, focus return, password rotation
and clearing, preference access for every tested role, locale persistence/rollback, theme and
mode changes, directory authorization failure/retry, archive refusal, ignoring late Enter
responses, preserved list state, keyboard category changes and retained drafts. Existing tests
continue to verify workspace roles, approval controls and archive confirmation. An initial full
run exposed stale UI expectations/tooling and one unrelated five-second deployment-fixture
timeout; the final full run passed without increasing timeouts or skipping tests.

Browser checks used the bundled mock Gateway at desktop 1280×800 and mobile 390×844: the shared
preferences dialog, language/theme/mode changes, close-focus return, read-only account values,
explicit name/password editors, cancel, directory actions, category switching and a retained
name draft. Enter selected the requested mock workspace and opened its Chats. The mobile
list and settings panels stayed within the viewport; the category bar scrolls independently.
Screenshots and local check logs are kept in the private 2026-10-22 trial evidence bundle.
No real account password, model call or stable deployment was changed during these checks.
