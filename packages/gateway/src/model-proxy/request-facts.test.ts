// T0: what the model proxy reads from a request body for `model_requests`, never the text itself.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, requestFacts, requestShape, systemSha256 } from "./request-facts.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }, "x"] })).toBe(
      '{"a":[{"c":3,"d":2},"x"],"b":1}',
    );
  });
});

describe("systemSha256", () => {
  it("hashes a string system prompt as its canonical JSON (a JSON string)", () => {
    expect(systemSha256("You are Nova.")).toBe(sha('"You are Nova."'));
  });

  it("hashes block arrays independently of key order", () => {
    const a = [{ type: "text", text: "You are Nova.", cache_control: { type: "ephemeral" } }];
    const b = [{ cache_control: { type: "ephemeral" }, text: "You are Nova.", type: "text" }];
    expect(systemSha256(a)).toBe(systemSha256(b));
    expect(systemSha256(a)).not.toBe(systemSha256("You are Nova."));
  });

  it("is undefined when the request has no system field", () => {
    expect(systemSha256(undefined)).toBeUndefined();
  });
});

describe("requestFacts", () => {
  it("reads model, stream and the system hash", () => {
    const body = Buffer.from(
      JSON.stringify({ model: "m", stream: true, system: "S", messages: [], max_tokens: 5 }),
    );
    expect(requestFacts(body)).toEqual({
      model: "m",
      stream: true,
      systemSha256: sha('"S"'),
      imageBlocks: 0,
      shape: {
        cacheControlBlocks: 0,
        systemBlocks: 1,
        systemChars: 1,
        systemDynamicSha256: sha('["S"]'),
        systemBlockHashes: [sha('"S"').slice(0, 16)],
        toolsCount: 0,
        toolsChars: 0,
        messagesCount: 0,
      },
    });
  });

  it("never fails: a body that is not JSON gives no facts and stream false", () => {
    expect(requestFacts(Buffer.from("not json"))).toEqual({ stream: false });
    expect(requestFacts(undefined)).toEqual({ stream: false });
    expect(requestFacts(Buffer.from("[1,2]"))).toEqual({ stream: false });
  });
});

// ADR-0023 amendment 5: whether the CLI's cache markers reach the upstream, which part of the
// system prompt changed, and how large each part of the request is.
describe("requestShape", () => {
  const ephemeral = { type: "ephemeral" };
  const billing = { type: "text", text: "billing header" };
  const prompt = { type: "text", text: "You are Nova.", cache_control: ephemeral };
  const tail = { type: "text", text: "## Images" };

  it("splits the system prompt after the last block that carries cache_control", () => {
    const shape = requestShape({ system: [billing, prompt, tail] });
    expect(shape.systemBlocks).toBe(3);
    expect(shape.systemChars).toBe("billing header".length + "You are Nova.".length + 9);
    expect(shape.systemStaticSha256).toBe(sha(canonicalJson([billing, prompt])));
    expect(shape.systemDynamicSha256).toBe(sha(canonicalJson([tail])));
    expect(shape.systemBlockHashes).toEqual(
      [billing, prompt, tail].map((b) => sha(canonicalJson(b)).slice(0, 16)),
    );
  });

  it("calls the whole prompt dynamic without a marker and static when the last block has one", () => {
    expect(requestShape({ system: [billing, tail] })).not.toHaveProperty("systemStaticSha256");
    expect(requestShape({ system: [billing, prompt] })).not.toHaveProperty("systemDynamicSha256");
    expect(requestShape({})).toMatchObject({
      systemBlocks: 0,
      systemChars: 0,
      systemBlockHashes: [],
    });
  });

  it("keeps the static hash when only the dynamic part changes", () => {
    const one = requestShape({ system: [prompt, tail] });
    const two = requestShape({ system: [prompt, { type: "text", text: "## Other" }] });
    expect(two.systemStaticSha256).toBe(one.systemStaticSha256);
    expect(two.systemDynamicSha256).not.toBe(one.systemDynamicSha256);
  });

  it("counts cache_control markers in system, tools and messages, nested tool results too", () => {
    const shape = requestShape({
      system: [prompt],
      tools: [{ name: "Bash", input_schema: {}, cache_control: ephemeral }, { name: "Read" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: ephemeral }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [{ type: "text", text: "x", cache_control: ephemeral }],
            },
          ],
        },
      ],
    });
    expect(shape.cacheControlBlocks).toBe(4);
    expect(shape.toolsCount).toBe(2);
    expect(shape.toolsChars).toBe(
      JSON.stringify([
        { name: "Bash", input_schema: {}, cache_control: ephemeral },
        { name: "Read" },
      ]).length,
    );
    expect(shape.messagesCount).toBe(2);
  });
});
