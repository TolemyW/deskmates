// The operator UI's entry module. The app lives in `src/app/` (bootstrap, sign-in, invitation,
// tenant switcher, the signed-in shell and its navigation) and each screen's routes, link and
// rendering in `src/features/<feature>/` (issue #53); this module keeps the old import path.

export { App } from "./app/bootstrap.js";
export { InviteScreen } from "./app/invite-screen.js";
export { TenantSwitcher } from "./app/tenant-switcher.js";
