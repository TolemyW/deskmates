import { describe, expect, it } from "vitest";
import { createFakeGraph } from "../test-support/fake-graph.js";
import { WHATSAPP_TEXT_MAX, chunkText, messagesUrl, sendText } from "./outbound.js";

const target = {
  graphBaseUrl: "https://graph.example.test",
  graphApiVersion: "v23.0",
  phoneNumberId: "100200",
  accessToken: "EAAB-token",
};

describe("chunkText", () => {
  it("keeps short text whole and splits long text at newlines before the limit", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("")).toEqual([""]);
    const paragraph = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    expect(chunkText(paragraph)).toEqual(["a".repeat(3000), "b".repeat(3000)]);
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(words);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(WHATSAPP_TEXT_MAX);
    expect(chunks.join(" ")).toBe(words);
    const solid = "x".repeat(WHATSAPP_TEXT_MAX * 2 + 1);
    expect(chunkText(solid).map((c) => c.length)).toEqual([4096, 4096, 1]);
  });
});

describe("sendText", () => {
  it("posts the Cloud API text body with the Bearer token and returns the message id", async () => {
    const graph = createFakeGraph();
    const result = await sendText(
      { ...target, fetch: graph.fetch, retries: 3 },
      "8613800000000",
      "hi",
    );
    expect(result).toEqual({ ok: true, messageId: "wamid.out.1", attempts: 1 });
    expect(graph.sends).toHaveLength(1);
    expect(graph.sends[0]?.url).toBe(messagesUrl(target));
    expect(graph.sends[0]?.url).toBe("https://graph.example.test/v23.0/100200/messages");
    expect(graph.sends[0]?.authorization).toBe("Bearer EAAB-token");
    expect(graph.sends[0]?.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "8613800000000",
      type: "text",
      text: { preview_url: false, body: "hi" },
    });
  });

  it("retries 429 and 5xx with backoff, then gives up with the status", async () => {
    const graph = createFakeGraph();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    graph.queue.push({ status: 429, body: { error: { code: 130429, message: "rate" } } });
    graph.queue.push({ status: 503 });
    const ok = await sendText({ ...target, fetch: graph.fetch, retries: 3, sleep }, "861", "x");
    expect(ok).toMatchObject({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([500, 1000]);

    graph.sends.length = 0;
    graph.queue.push({ status: 500 }, { status: 500 }, { status: 500 });
    const gaveUp = await sendText({ ...target, fetch: graph.fetch, retries: 2, sleep }, "861", "x");
    expect(gaveUp).toMatchObject({ ok: false, status: 500, attempts: 3, retryable: true });
    expect(graph.sends).toHaveLength(3);
  });

  it("does not retry other errors and reports Meta's code", async () => {
    const graph = createFakeGraph();
    graph.queue.push({
      status: 400,
      body: { error: { message: "Re-engagement message", code: 131047 } },
    });
    const result = await sendText({ ...target, fetch: graph.fetch, retries: 3 }, "861", "x");
    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 131047,
      message: "Re-engagement message",
      attempts: 1,
      retryable: false,
    });
    expect(graph.sends).toHaveLength(1);
  });

  it("retries a network failure and reports it when retries run out", async () => {
    let calls = 0;
    const failing: typeof fetch = async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    };
    const result = await sendText(
      { ...target, fetch: failing, retries: 1, sleep: async () => {} },
      "861",
      "x",
    );
    expect(result).toMatchObject({ ok: false, status: 0, message: "ECONNRESET", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("uses the HTTP status when the response body disconnects", async () => {
    const disconnected = (status: number): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("response body connection reset"));
          },
        }),
        { status },
      );
    let calls = 0;
    const recovered: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? disconnected(503)
        : Response.json({ messages: [{ id: "wamid.recovered" }] });
    };
    expect(
      await sendText(
        { ...target, fetch: recovered, retries: 1, sleep: async () => {} },
        "861",
        "x",
      ),
    ).toEqual({ ok: true, messageId: "wamid.recovered", attempts: 2 });

    for (const status of [429, 503]) {
      expect(
        await sendText(
          { ...target, fetch: async () => disconnected(status), retries: 0 },
          "861",
          "x",
        ),
      ).toMatchObject({ ok: false, status, attempts: 1, retryable: true });
    }
    expect(
      await sendText({ ...target, fetch: async () => disconnected(400), retries: 3 }, "861", "x"),
    ).toMatchObject({ ok: false, status: 400, attempts: 1, retryable: false });
    expect(
      await sendText({ ...target, fetch: async () => disconnected(200), retries: 3 }, "861", "x"),
    ).toEqual({ ok: true, messageId: undefined, attempts: 1 });
  });
});
