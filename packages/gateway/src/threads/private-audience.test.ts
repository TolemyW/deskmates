// T1: the private audience is recorded on a person's side chat (ADR-0031 decision 9; owner
// answer Q5: people only). Enforcement on every read and stream is the #116 audience lane.

import type { BotId, WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { AuthService } from "../auth/auth-service.js";
import { BotStore } from "../bots/bots.js";
import { openDatabase } from "../db/open.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { ThreadStore } from "./threads.js";

describe("private audience (ADR-0031 decision 9)", () => {
  it("a person's side chat is private to them; a service principal's stays shared", async () => {
    const db = openDatabase(":memory:");
    const auth = new AuthService(db, { passwordMinLength: 8 });
    const ws = new WorkspaceStore(db).create({ name: "W", sandboxProvider: "docker" });
    const bot = new BotStore(db).create({
      workspaceId: ws.id as WorkspaceId,
      name: "b",
      role: "r",
    });
    const person = await auth.createUser({
      loginName: "pat",
      displayName: "Pat",
      password: "correct horse battery staple",
      role: "member",
      workspaceId: ws.id,
    });
    const threads = new ThreadStore(db);
    const mine = threads.create({
      workspaceId: ws.id as WorkspaceId,
      botIds: [bot.id as BotId],
      sideChatActor: `user:${person.id}`,
    });
    const machine = threads.create({
      workspaceId: ws.id as WorkspaceId,
      botIds: [bot.id as BotId],
      sideChatActor: "service:svc_1",
    });
    const audience = (id: string) =>
      db.prepare("SELECT opened_by, private_to_user_id FROM threads WHERE id = ?").get(id);
    expect(audience(mine.id)).toEqual({
      opened_by: `user:${person.id}`,
      private_to_user_id: person.id,
    });
    expect(audience(machine.id)).toEqual({ opened_by: "service:svc_1", private_to_user_id: null });
  });
});
