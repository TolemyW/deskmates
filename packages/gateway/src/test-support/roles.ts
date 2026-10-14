// Test fixture for ADR-0022 amendment 6: one workspace with a bot and one signed-in person per
// workspace role, plus the root. Each person is a `BrowserJar` signed in through the UI's flow.

import type { BotDefinition, Workspace } from "@deskmates/contracts";
import type { TenantRole } from "@deskmates/contracts";
import { BrowserJar, TEST_PASSWORD } from "./browser-session.js";
import type { Harness } from "./harness.js";
import { createOwner } from "./owner.js";

export interface RoleFixture {
  workspace: Workspace;
  bot: BotDefinition;
  root: BrowserJar;
  owner: BrowserJar;
  admin: BrowserJar;
  member: BrowserJar;
  otherMember: BrowserJar;
  guest: BrowserJar;
  /** User ids by login name. */
  ids: Record<string, string>;
}

export async function seedRoles(h: Harness): Promise<RoleFixture> {
  const { ctx } = h.app.deskmates;
  h.app.deskmates.scheduler.stop();
  const rootUser = await createOwner(ctx.auth, {
    loginName: "admin",
    displayName: "Root",
    password: TEST_PASSWORD,
  });
  const workspace = ctx.workspaces.create({ name: "W", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: workspace.id, name: "helper", role: "helps" });
  const ids: Record<string, string> = { admin: rootUser.id };
  const people: Array<[string, TenantRole]> = [
    ["oona", "owner"],
    ["ada", "admin"],
    ["mel", "member"],
    ["max", "member"],
    ["gus", "guest"],
  ];
  for (const [loginName, role] of people)
    ids[loginName] = (
      await ctx.auth.createUser({
        loginName,
        displayName: loginName,
        password: TEST_PASSWORD,
        role,
        workspaceId: workspace.id,
      })
    ).id;
  const signedIn = async (loginName: string) => {
    const jar = new BrowserJar(h.baseUrl);
    const response = await jar.signIn(loginName);
    if (response.status !== 200) throw new Error(`${loginName} could not sign in`);
    return jar;
  };
  return {
    workspace,
    bot,
    root: await signedIn("admin"),
    owner: await signedIn("oona"),
    admin: await signedIn("ada"),
    member: await signedIn("mel"),
    otherMember: await signedIn("max"),
    guest: await signedIn("gus"),
    ids,
  };
}

/** Read a person's live stream for `ms` milliseconds and return the raw text. */
export async function streamText(
  h: Harness,
  jar: BrowserJar,
  during: () => Promise<void>,
  ms = 300,
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${h.baseUrl}/api/events`, {
    headers: { cookie: jar.cookieHeader() },
    signal: controller.signal,
  });
  if (response.status !== 200) throw new Error(`stream refused: ${response.status}`);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const reading = (async () => {
    try {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    } catch {
      // aborted
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  await during();
  await new Promise((r) => setTimeout(r, ms));
  controller.abort();
  await reading;
  return text;
}
