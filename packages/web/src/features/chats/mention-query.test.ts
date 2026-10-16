import type { BotId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  activeMention,
  applyMention,
  mentionOptions,
  previewMentions,
  unaddressedRoute,
} from "./mention-query.js";

const members = [
  { botId: "b1" as BotId, name: "team_chief" },
  { botId: "b2" as BotId, name: "databricks_fan" },
  { botId: "b3" as BotId, name: "poor_developer" },
];

describe("activeMention", () => {
  it("finds the @partial at the caret, at the start or after punctuation or CJK text", () => {
    expect(activeMention("@te", 3)).toEqual({ start: 0, query: "te" });
    expect(activeMention("请 @", 3)).toEqual({ start: 2, query: "" });
    expect(activeMention("请@dat", 5)).toEqual({ start: 1, query: "dat" });
    expect(activeMention("hi，@po", 6)).toEqual({ start: 3, query: "po" });
  });

  it("is absent inside an email-like word, after a space, or when the caret is elsewhere", () => {
    expect(activeMention("a@b", 3)).toBeUndefined();
    expect(activeMention("@team_chief ", 12)).toBeUndefined();
    expect(activeMention("@team_chief hello", 17)).toBeUndefined();
  });
});

describe("mentionOptions", () => {
  it("filters member names by prefix, case-insensitively, then offers everyone", () => {
    expect(mentionOptions(members, "")).toEqual([
      "team_chief",
      "databricks_fan",
      "poor_developer",
      "everyone",
    ]);
    expect(mentionOptions(members, "D")).toEqual(["databricks_fan"]);
    expect(mentionOptions(members, "ev")).toEqual(["everyone"]);
    expect(mentionOptions(members, "zz")).toEqual([]);
  });
});

describe("applyMention", () => {
  it("replaces the partial with the exact name and one trailing space", () => {
    const text = "请 @te 看一下";
    const caret = 5;
    const mention = activeMention(text, caret);
    expect(mention).toBeDefined();
    const out = applyMention(text, mention ?? { start: 0, query: "" }, caret, "team_chief");
    expect(out.text).toBe("请 @team_chief 看一下");
    expect(out.text.slice(0, out.caret)).toBe("请 @team_chief ");
  });

  it("adds the space at the end of the text", () => {
    const out = applyMention("@po", { start: 0, query: "po" }, 3, "poor_developer");
    expect(out).toEqual({ text: "@poor_developer ", caret: 16 });
  });
});

describe("previewMentions", () => {
  it("names the bots the Gateway will wake, in order and once each", () => {
    expect(previewMentions("@team_chief 和 @databricks_fan，再问 @team_chief", members)).toEqual({
      woken: ["team_chief", "databricks_fan"],
      everyone: false,
      unknown: [],
    });
  });

  it("flags names that match no member, which wake nobody", () => {
    const preview = previewMentions("@team_cheif 请看", members);
    expect(preview.woken).toEqual([]);
    expect(preview.unknown).toEqual(["team_cheif"]);
  });

  it("reports everyone, and nothing for a message with no mention", () => {
    expect(previewMentions("@everyone 开会", members).everyone).toBe(true);
    expect(previewMentions("大家好", members)).toEqual({ woken: [], everyone: false, unknown: [] });
  });

  it("does not treat `@ team_chief` (a space after @) as a mention", () => {
    expect(previewMentions("@ team_chief", members).woken).toEqual([]);
  });
});

describe("unaddressedRoute", () => {
  const WALK = {
    line: "No @mention: every member is woken in turn",
    warning: ". With no valid mention, every member is woken in turn.",
  };

  it("keeps the walk wording under walk-v1 and when the Gateway does not say", () => {
    expect(unaddressedRoute(members, "walk-v1", "b1" as BotId)).toEqual(WALK);
    expect(unaddressedRoute(members, undefined, "b1" as BotId)).toEqual(WALK);
  });

  it("names the owner first under owner-v1", () => {
    expect(unaddressedRoute(members, "owner-v1", "b2" as BotId)).toEqual({
      line: "No @mention: offered to @databricks_fan first, then to the other members until one replies",
      warning:
        ". With no valid mention, it is offered to @databricks_fan first, then to the other members until one replies.",
    });
  });

  it("offers one member at a time under owner-v1 with no owner or an owner who left", () => {
    const none = {
      line: "No @mention: offered to one member at a time until one replies",
      warning: ". With no valid mention, it is offered to one member at a time until one replies.",
    };
    expect(unaddressedRoute(members, "owner-v1", undefined)).toEqual(none);
    expect(unaddressedRoute(members, "owner-v1", "gone" as BotId)).toEqual(none);
  });

  it("keeps the one-member wording whatever the routing", () => {
    const one = members.slice(0, 1);
    expect(unaddressedRoute(one, "owner-v1", "b1" as BotId)).toEqual(WALK);
    expect(unaddressedRoute(one, "owner-v1", undefined)).toEqual(WALK);
  });
});

describe("round-v1 in the composer (ADR-0005 amendment 6)", () => {
  it("says a plan picks who works and answers, in a group only", () => {
    expect(unaddressedRoute(members, "round-v1", "b1" as BotId)).toEqual({
      line: "No @mention: a quick plan picks who works on it and who answers",
      warning: ". With no valid mention, a quick plan picks who works on it and who answers.",
    });
    expect(unaddressedRoute(members.slice(0, 1), "round-v1", undefined).line).toBe(
      "No @mention: every member is woken in turn",
    );
  });

  it("previews `@ name` as the Gateway reads it under round-v1", () => {
    expect(previewMentions("@ team_chief", members, { spaced: true }).woken).toEqual([
      "team_chief",
    ]);
  });
});
