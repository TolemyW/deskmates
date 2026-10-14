// @vitest-environment node
// T0: the manual's About lists exactly the notices the build emits under third-party/ (issue #28).

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { OPEN_SOURCE_NOTICES } from "./open-source-notices.js";

it("lists exactly the notices the build ships under third-party/", () => {
  const shipped = readdirSync(fileURLToPath(new URL("../../../ui/legal/", import.meta.url))).sort();
  expect([...OPEN_SOURCE_NOTICES].sort()).toEqual(shipped);
});
