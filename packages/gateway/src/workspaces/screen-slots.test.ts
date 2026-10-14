import { afterEach, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { openDatabase } from "../db/open.js";
import { ScreenSlotStore } from "./screen-slots.js";
import { WorkspaceStore } from "./workspaces.js";
const db = openDatabase(":memory:");
afterEach(() => {
  db.prepare("DELETE FROM bot_screen_slots").run();
});
it("keeps bot allocations stable and rejects exhaustion without reassigning existing screens", () => {
  const ws = new WorkspaceStore(db).create({
    name: "screens",
    sandboxProvider: "docker",
    egressAllowlist: [],
  });
  const bots = new BotStore(db);
  const slots = new ScreenSlotStore(db);
  const members = Array.from({ length: 7 }, (_, i) =>
    bots.create({ name: `bot${i}`, role: "", workspaceId: ws.id }),
  );
  expect(members.slice(0, 6).map((bot) => slots.ensure(bot.id, ws.id))).toEqual([0, 1, 2, 3, 4, 5]);
  const restored = new ScreenSlotStore(db);
  const [first, , third, , , , seventh] = members;
  if (!first || !third || !seventh) throw new Error("Missing fixture bots");
  expect(restored.ensure(third.id, ws.id)).toBe(2);
  expect(() => restored.ensure(seventh.id, ws.id)).toThrow("six allocated");
  expect(restored.get(seventh.id)).toBeUndefined();
  expect(restored.get(first.id)).toBe(0);
});
