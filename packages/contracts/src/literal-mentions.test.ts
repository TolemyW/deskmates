import { describe, expect, it } from "vitest";
import type { BotId } from "./ids.js";
import { mentionDiagnostics, parseMentions } from "./thread.js";

const author = "bot-author" as BotId;
const peer = "bot-peer" as BotId;
const members = [
  { botId: author, name: "author" },
  { botId: peer, name: "peer" },
];

describe("literal mentions (ADR-0056)", () => {
  it.each([
    "A report about `@everyone @peer @missing @ peer`.",
    "``@everyone ` @peer @missing @ peer``",
    "```text\n@everyone @peer @missing @ peer\n```",
    "~~~~text\n@everyone @peer @missing @ peer\n~~~~~",
    "```text\n@everyone @peer @missing @ peer",
    "> Quoted @everyone @peer @missing @ peer",
    "\\@everyone \\@peer \\@missing \\@ peer",
  ])("does not route or diagnose literal text: %s", (body) => {
    for (const options of [{}, { spaced: true }]) {
      expect(parseMentions(body, members, author, options)).toEqual([]);
      expect(mentionDiagnostics(body, members, author, options)).toEqual({
        unknown: [],
        spaced: [],
      });
    }
    expect(parseMentions(body, members)).toEqual([]);
  });

  it("replays the report's incidental broadcast without starting a broadcast", () => {
    const body =
      "考虑但排除 4 项（synthetic usage、成员名 ASCII 限制、@everyone 丢提及、测试密度）。";
    expect(parseMentions(body, members, author)).toEqual([]);
    expect(parseMentions(body, members)).toEqual([{ kind: "everyone" }]);
  });

  it.each(["@everyone begin", " \n@EVERYONE: begin", "@peer, @everyone begin"])(
    "retains the bot's explicit leading broadcast: %s",
    (body) => {
      expect(parseMentions(body, members, author)).toEqual([{ kind: "everyone" }]);
    },
  );

  it("does not erase an individual handoff when a later broadcast is literal", () => {
    expect(
      parseMentions("@peer review this; the report discusses @everyone", members, author),
    ).toEqual([{ kind: "bot", botId: peer }]);
    expect(parseMentions("Please ask @peer to review", members, author)).toEqual([
      { kind: "bot", botId: peer },
    ]);
  });

  it("does not infer negation, and retains spaced member mentions outside code", () => {
    expect(parseMentions("Do not call @peer", members, author)).toEqual([
      { kind: "bot", botId: peer },
    ]);
    expect(parseMentions("`@ missing` @ peer", members, author, { spaced: true })).toEqual([
      { kind: "bot", botId: peer },
    ]);
    expect(mentionDiagnostics("`@missing @ peer` @outside", members, author)).toEqual({
      unknown: ["outside"],
      spaced: [],
    });
  });

  it("matches fence lengths and resumes routing after the closing fence", () => {
    expect(parseMentions("````\n```\n@everyone\n````\n@peer", members, author)).toEqual([
      { kind: "bot", botId: peer },
    ]);
    expect(parseMentions("~~~\n@peer\n```\n@everyone", members, author)).toEqual([]);
    expect(parseMentions("```\n@peer\n``` not a close\n@everyone", members, author)).toEqual([]);
  });

  it("keeps unmatched inline delimiters and even backslash escapes as ordinary prose", () => {
    expect(parseMentions("one unmatched ` and @peer", members, author)).toEqual([
      { kind: "bot", botId: peer },
    ]);
    expect(parseMentions("\\\\@peer", members, author)).toEqual([{ kind: "bot", botId: peer }]);
    expect(parseMentions("`@everyone`\n@peer review", members, author)).toEqual([
      { kind: "bot", botId: peer },
    ]);
  });
});
