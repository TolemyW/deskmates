// T0: the one-line message preview (issue #16). A leading fence and its closing fence go, the
// whitespace collapses, and the cut lands on a grapheme boundary.

import { describe, expect, it } from "vitest";
import { messageExcerpt, messageExcerptSourceChars } from "./message-excerpt.js";

describe("messageExcerpt", () => {
  it("strips a fence that shares its line with the object", () => {
    expect(messageExcerpt('```json {"done": "checked", "reply": "All good."} ```', 160)).toBe(
      '{"done": "checked", "reply": "All good."}',
    );
    expect(messageExcerpt('```json{"done":"x"}```', 160)).toBe('{"done":"x"}');
  });

  it("strips a fence on its own line and its closing fence, keeping what follows", () => {
    const body = '```json\n{\n  "done": "checked",\n  "reply": "All good."\n}\n```\nThanks.';
    expect(messageExcerpt(body, 160)).toBe('{ "done": "checked", "reply": "All good." } Thanks.');
    expect(messageExcerpt("~~~\nplain\n~~~", 160)).toBe("plain");
  });

  it("strips the opening fence of a cut prefix that never closes", () => {
    expect(messageExcerpt('```json\n{"done": "a long', 160)).toBe('{"done": "a long');
  });

  it("leaves a body without a leading fence alone apart from whitespace", () => {
    expect(messageExcerpt("  Report ready:\n\n /work/out.md \t done ", 160)).toBe(
      "Report ready: /work/out.md done",
    );
    expect(messageExcerpt("See:\n```js\nx()\n```", 160)).toBe("See: x()");
    expect(messageExcerpt("", 160)).toBe("");
  });

  it("turns emphasis, links and inline code into plain text", () => {
    expect(
      messageExcerpt(
        "**ops.example.test** is [ready](https://example.test/status) in `deploy.log`; _check it_.",
        160,
      ),
    ).toBe("ops.example.test is ready in deploy.log; check it.");
    expect(messageExcerpt("- ~~old~~ and ![chart](chart.png)", 160)).toBe("old and chart");
    expect(
      messageExcerpt("keep snake_case, mcp__browser__open and escaped \\*literal\\*", 160),
    ).toBe("keep snake_case, mcp__browser__open and escaped *literal*");
  });

  it("cuts CJK text and emoji on a grapheme boundary", () => {
    expect(messageExcerpt("报告已经完成，请查收", 4)).toBe("报告已经");
    // A family emoji is one grapheme of several code points; it is kept whole or not at all.
    const family = "👨‍👩‍👧";
    expect(messageExcerpt(`好${family}的`, 2)).toBe(`好${family}`);
    expect(messageExcerpt(`好${family}的`, 1)).toBe("好");
    expect(messageExcerpt("étude", 1)).toBe("é");
  });

  it("never ends on a space after the cut", () => {
    expect(messageExcerpt("ab cd", 3)).toBe("ab");
  });

  it("reads a bounded prefix large enough for a fence and collapsing whitespace", () => {
    expect(messageExcerptSourceChars(160)).toBeGreaterThanOrEqual(160 * 4);
    expect(messageExcerptSourceChars(160)).toBeLessThanOrEqual(4096);
  });
});
