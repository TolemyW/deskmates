// T0: what the model proxy reads from a request body for `model_requests`, never the text itself.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, requestFacts, systemSha256 } from "./request-facts.js";

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
    });
  });

  it("never fails: a body that is not JSON gives no facts and stream false", () => {
    expect(requestFacts(Buffer.from("not json"))).toEqual({ stream: false });
    expect(requestFacts(undefined)).toEqual({ stream: false });
    expect(requestFacts(Buffer.from("[1,2]"))).toEqual({ stream: false });
  });
});
