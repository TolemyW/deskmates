// T1 (ADR-0048 decision 1, amendment 1 A1): the desktop tool routes. A Member reads, only an
// Admin changes; the tools are off while the image cannot be read and turning them on is refused;
// once the image declares the capability they are on by default, with the grouping exception, and
// an Admin can turn a bot off.

import {
  DESKTOP_LCU_CAPABILITY,
  type DesktopToolsView,
  type SandboxProvider,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("desktop tool routes (ADR-0048)", () => {
  it("a Member reads, the tools are on by default on a capable image only, an Admin turns a bot off", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const people = await seedRoles(harness);
    const path = `/api/workspaces/${people.workspace.id}/desktop-tools`;
    const provider = harness.provider as SandboxProvider;

    const read = await people.member.json<{ desktopTools: DesktopToolsView }>("GET", path);
    expect(read.status).toBe(200);
    expect(read.json.desktopTools).toMatchObject({
      enabled: false,
      setting: "default",
      image: "unknown",
      groupingException: false,
    });

    expect((await people.member.fetch("PUT", path, { body: { enabled: true } })).status).toBe(403);
    expect((await people.admin.fetch("PUT", path, { body: { enabled: true } })).status).toBe(400);

    provider.imageLabels = async () => ({
      "org.deskmates.capabilities": `other, ${DESKTOP_LCU_CAPABILITY}`,
      "org.deskmates.desktop.lcu-version": "0.11.3",
    });
    const byDefault = await people.member.json<{ desktopTools: DesktopToolsView }>("GET", path);
    expect(byDefault.json.desktopTools).toMatchObject({
      enabled: true,
      setting: "default",
      image: "capable",
      lcuVersion: "0.11.3",
      groupingException: true,
      bots: [{ botId: people.bot.id, enabled: true, setting: "default" }],
    });
    const off = await people.admin.json<{ desktopTools: DesktopToolsView }>("PUT", path, {
      body: { bots: { [people.bot.id]: false } },
    });
    expect(off.status).toBe(200);
    expect(off.json.desktopTools).toMatchObject({
      enabled: true,
      bots: [{ botId: people.bot.id, enabled: false, setting: "off" }],
    });
  });
});
