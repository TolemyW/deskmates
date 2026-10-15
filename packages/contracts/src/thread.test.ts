import { describe, expect, it } from "vitest";
import type { BotId } from "./ids.js";
import {
  isOwnSideChat,
  isPastDeadline,
  laneForThread,
  mentionDiagnostics,
  normalizeDeadline,
  parseMentions,
} from "./thread.js";

const alice = "b-alice" as BotId;
const bob = "b-bob" as BotId;
const members = [
  { botId: alice, name: "alice" },
  { botId: bob, name: "bob" },
];

describe("mentionDiagnostics (ADR-0005 amendment 2)", () => {
  it("reports names nobody has and member names written with a space after the @", () => {
    expect(mentionDiagnostics("@ bob please, cc @human and @alice", members, alice)).toEqual({
      unknown: ["human"],
      spaced: ["bob"],
    });
  });

  it("finds nothing in a clean message, an @everyone, or the author's own spaced name", () => {
    expect(mentionDiagnostics("@bob and @everyone, mail me at a@b.c", members)).toEqual({
      unknown: [],
      spaced: [],
    });
    expect(mentionDiagnostics("@ alice is me", members, alice)).toEqual({
      unknown: [],
      spaced: [],
    });
    expect(mentionDiagnostics("the rate @ 5 percent", members)).toEqual({
      unknown: [],
      spaced: [],
    });
  });

  it("does not change what parseMentions reads", () => {
    expect(parseMentions("@ bob please", members)).toEqual([]);
  });
});

describe("parseMentions (ADR-0005 item 3)", () => {
  it("resolves member names case-insensitively, once each", () => {
    expect(parseMentions("@Alice please, and @bob; @alice again", members)).toEqual([
      { kind: "bot", botId: alice },
      { kind: "bot", botId: bob },
    ]);
  });

  it("ignores unknown names and self-mentions", () => {
    expect(parseMentions("@carol @alice", members, alice)).toEqual([]);
  });

  it("collapses @everyone to a single everyone mention", () => {
    expect(parseMentions("@alice @everyone @bob", members)).toEqual([{ kind: "everyone" }]);
  });

  it("does not match email addresses", () => {
    expect(parseMentions("mail alice@bob.example", members)).toEqual([]);
  });

  it("returns nothing for an unaddressed message", () => {
    expect(parseMentions("hello all", members)).toEqual([]);
  });
});

describe("spaced mentions (ADR-0005 amendment 6, decision 50)", () => {
  const spaced = { spaced: true };

  it("reads a member written `@ name` as a mention, in order with the others", () => {
    expect(parseMentions("@  Bob and @alice", members, undefined, spaced)).toEqual([
      { kind: "bot", botId: bob },
      { kind: "bot", botId: alice },
    ]);
  });

  it("still ignores unknown names, self-mentions, `@ everyone`, emails and a spaced number", () => {
    expect(parseMentions("@ carol, @ alice", members, alice, spaced)).toEqual([]);
    expect(parseMentions("@ everyone hi", members, undefined, spaced)).toEqual([]);
    expect(parseMentions("mail alice@ bob.example", members, undefined, spaced)).toEqual([]);
    expect(parseMentions("the rate @ 5 percent", members, undefined, spaced)).toEqual([]);
  });

  it("is off by default, and leaves nothing spaced to report when on", () => {
    expect(parseMentions("@ bob please", members)).toEqual([]);
    expect(mentionDiagnostics("@ bob and @carol", members, alice, spaced)).toEqual({
      unknown: ["carol"],
      spaced: [],
    });
  });
});

describe("laneForThread (ADR-0005 item 7)", () => {
  it("chat is interactive, bus is background", () => {
    expect(laneForThread("chat")).toBe("interactive");
    expect(laneForThread("bus")).toBe("background");
  });
});

describe("thread deadline (issue #21)", () => {
  it("normalizes a zoned ISO date-time to canonical UTC and refuses anything else", () => {
    expect(normalizeDeadline("2026-10-09T18:00:00+08:00")).toBe("2026-10-09T10:00:00.000Z");
    expect(normalizeDeadline("2026-10-09T10:00Z")).toBe("2026-10-09T10:00:00.000Z");
    expect(normalizeDeadline("2026-10-09")).toBeUndefined();
    expect(normalizeDeadline("2026-10-09T10:00:00")).toBeUndefined();
    expect(normalizeDeadline("2026-13-40T10:00:00Z")).toBeUndefined();
    expect(normalizeDeadline("tomorrow")).toBeUndefined();
  });

  it("is past at and after the deadline, never without one", () => {
    const now = new Date("2026-10-09T10:00:00.000Z");
    expect(isPastDeadline({}, now)).toBe(false);
    expect(isPastDeadline({ deadline: "2026-10-09T10:00:00.000Z" }, now)).toBe(true);
    expect(isPastDeadline({ deadline: "2026-10-09T09:59:59.000Z" }, now)).toBe(true);
    expect(isPastDeadline({ deadline: "2026-10-09T10:00:01.000Z" }, now)).toBe(false);
  });
});

describe("isOwnSideChat (ADR-0022 amendment 1)", () => {
  it("is a one-bot chat the actor opened as a side chat, and nothing else", () => {
    const side = { kind: "chat" as const, sideChatActor: "user:u1" };
    expect(isOwnSideChat(side, 1, "user:u1")).toBe(true);
    expect(isOwnSideChat(side, 1, "user:u2")).toBe(false);
    expect(isOwnSideChat(side, 2, "user:u1")).toBe(false);
    expect(isOwnSideChat({ kind: "bus", sideChatActor: "user:u1" }, 1, "user:u1")).toBe(false);
    expect(isOwnSideChat({ kind: "chat" }, 1, "user:u1")).toBe(false);
  });
});
