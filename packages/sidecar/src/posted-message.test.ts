// T0: the wording of a `thread_post` result from the Gateway's routing facts.

import { describe, expect, it } from "vitest";
import { describePosted } from "./posted-message.js";

const base = { seq: 4, addressed: [], everyone: false, unknown: [], spaced: [] };

describe("describePosted", () => {
  it("reports private handoffs and refusals without claiming that a delivered handoff woke nobody", () => {
    const delivered = describePosted(
      { ...base, handoffs: [{ name: "chief", delivered: true }] },
      true,
    );
    expect(delivered).toContain("Handed off to @chief in a separate conversation.");
    expect(delivered).not.toContain("wakes nobody");
    expect(
      describePosted(
        {
          ...base,
          handoffs: [{ name: "chief", delivered: false, reason: "conversation is paused" }],
        },
        true,
      ),
    ).toContain("@chief was not delivered: conversation is paused.");
  });
  it("keeps the old result for a Gateway that sends no routing facts", () => {
    expect(describePosted(undefined, true)).toBe("Posted to the thread.");
  });

  it("names whom the message addressed", () => {
    expect(describePosted({ ...base, addressed: ["g_stock", "g_lead"] }, true)).toBe(
      "Posted as message #4. It is addressed to g_stock, g_lead.",
    );
    expect(describePosted({ ...base, everyone: true }, true)).toBe(
      "Posted as message #4. It is addressed to everyone.",
    );
  });

  it("says a message that mentions nobody wakes nobody, under owner routing only", () => {
    expect(describePosted(base, true)).toBe(
      "Posted as message #4. It mentions no member, so it wakes nobody; the others read it with their next wake.",
    );
    expect(describePosted(base, false)).toBe("Posted as message #4. It mentions no member.");
  });

  it("points out a spaced mention and a name nobody has", () => {
    expect(describePosted({ ...base, spaced: ["g_stock"], unknown: ["human"] }, true)).toBe(
      'Posted as message #4. It mentions no member, so it wakes nobody; the others read it with their next wake. "@ g_stock" is not a mention: post again with @g_stock, no space, if g_stock has to act. No member of this thread is called @human.',
    );
  });

  // Issue #68 item 2: the Gateway created no run for the post, so the mention woke nobody.
  it.each([
    ["relay_count", "the thread's relay cap was reached"],
    ["turn_budget", "the thread reached its turn budget and is paused until a human messages it"],
    ["thread_paused", "the thread is paused until a human messages it"],
    ["deadline_passed", "the thread is past its deadline"],
  ] as const)("says whom a %s refusal did not wake", (wakeBlocked, reason) => {
    expect(describePosted({ ...base, addressed: ["g_stock"], wakeBlocked }, true)).toBe(
      `Posted as message #4. It is addressed to g_stock. @g_stock was not woken: ${reason}.`,
    );
  });

  it("names every addressee, or everyone, a refused wake left asleep", () => {
    expect(
      describePosted({ ...base, addressed: ["a", "b"], wakeBlocked: "thread_paused" }, true),
    ).toContain("@a, @b were not woken: the thread is paused until a human messages it.");
    expect(
      describePosted({ ...base, everyone: true, wakeBlocked: "thread_paused" }, true),
    ).toContain("Nobody was woken: the thread is paused until a human messages it.");
  });
});
