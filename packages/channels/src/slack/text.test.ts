// T0: Slack text in both directions and chunking.

import { describe, expect, it } from "vitest";
import { SLACK_TEXT_MAX, chunkSlackText, escapeSlackText, slackTextToPlain } from "./text.js";

describe("slackTextToPlain", () => {
  it("unescapes entities and flattens links, mentions and broadcasts", () => {
    expect(slackTextToPlain("a &lt;b&gt; &amp;amp; c")).toBe("a <b> &amp; c");
    expect(slackTextToPlain("see <https://x.test/a|docs> and <https://y.test>")).toBe(
      "see docs (https://x.test/a) and https://y.test",
    );
    expect(slackTextToPlain("<@U123> <@U456|ann> <#C1|general> <!here> <!subteam^S1|@ops>")).toBe(
      "@U123 @ann #general @here @ops",
    );
  });
});

describe("escapeSlackText", () => {
  it("escapes the control characters so a reply cannot mention, link or broadcast", () => {
    expect(escapeSlackText("<!channel> <@U1> <https://evil.test|x> a & b")).toBe(
      "&lt;!channel&gt; &lt;@U1&gt; &lt;https://evil.test|x&gt; a &amp; b",
    );
  });
});

describe("chunkSlackText", () => {
  it("keeps short text whole and empty text as one chunk", () => {
    expect(chunkSlackText("hi")).toEqual(["hi"]);
    expect(chunkSlackText("")).toEqual([""]);
  });

  it("cuts at a newline or a space under the limit", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    expect(chunkSlackText(text)).toEqual(["a".repeat(3000), "b".repeat(3000)]);
    const words = "word ".repeat(2000).trim();
    for (const chunk of chunkSlackText(words)) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
      expect(chunk.startsWith("word")).toBe(true);
    }
  });

  it("never splits an entity on a hard cut", () => {
    const text = escapeSlackText("&".repeat(5000));
    const chunks = chunkSlackText(text, 4000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
      expect(chunk).toMatch(/^(&amp;)+$/);
    }
    expect(chunks.join("")).toBe(text);
  });
});
