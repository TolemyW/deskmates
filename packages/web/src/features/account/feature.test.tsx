// @vitest-environment jsdom
// T0: Account settings has no navigation entry (the identity link opens it) and gets the
// session and its account client; global preferences belong to the shell.

import { expect, it } from "vitest";
import {
  STUB_CONTEXT,
  currentEntries,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { AccountSettingsScreen } from "./account-settings.js";
import { feature } from "./feature.js";

it("has no navigation entry, and no entry is current on it", () => {
  expect(feature.nav).toBeUndefined();
  expect(currentEntries("#/account")).toEqual([]);
});

describeRender("account", [
  [
    "#/account",
    AccountSettingsScreen,
    {
      session: STUB_CONTEXT.session,
      client: STUB_CONTEXT.account,
      onProfile: STUB_CONTEXT.onProfile,
      onSessionRotated: STUB_CONTEXT.onSessionRotated,
      onSignOut: STUB_CONTEXT.onSignOut,
    },
  ],
]);
