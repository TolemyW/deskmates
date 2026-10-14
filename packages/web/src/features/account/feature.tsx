// User Settings: Personal settings (profile, password, preferences, sign-out), Agent access and
// Workspaces (ADR-0034 decision 7). Reached from the identity link in the sidebar footer and the
// switcher's "Manage all workspaces", not from the main navigation.

import { defineFeature } from "../../app/feature.js";
import { WorkspaceManagement } from "../workspaces/workspace-management.js";
import { AccountSettingsScreen } from "./account-settings.js";
import { routes } from "./route.js";

export const feature = defineFeature(routes, {
  render: (route, ctx) => (
    <AccountSettingsScreen
      session={ctx.session}
      client={ctx.account}
      onProfile={ctx.onProfile}
      onSessionRotated={ctx.onSessionRotated}
      preferences={{
        locale: ctx.locale,
        onLocaleChange: ctx.changeLocale,
        theme: ctx.theme.preference,
        onThemeChange: ctx.theme.setPreference,
      }}
      onSignOut={ctx.onSignOut}
      page={route.page ?? "personal"}
      workspaces={
        route.page === "workspaces" ? (
          <WorkspaceManagement
            api={ctx.api}
            list={route.list ?? {}}
            {...(route.workspaceId ? { workspaceId: route.workspaceId } : {})}
          />
        ) : undefined
      }
    />
  ),
});
