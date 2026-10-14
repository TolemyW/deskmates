// The listener alone (ADR-0017 decision 5): handshake, signature, body limit, pass-through.

import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WEBHOOK_PATH, createWhatsAppServer } from "./server.js";
import { signBody } from "./signature.js";

const SECRET = "s3cret";
const VERIFY = "verify-token";

let server: Server;
let baseUrl: string;
let received: unknown[];
let answer: 200 | 503;
let warnings: string[];

beforeEach(async () => {
  received = [];
  answer = 200;
  warnings = [];
  server = createWhatsAppServer({
    handler: {
      handleWebhook: async (body) => {
        received.push(body);
        return { status: answer };
      },
    },
    verifyToken: VERIFY,
    appSecret: SECRET,
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    maxBodyBytes: 256,
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

async function post(body: string, signature?: string): Promise<Response> {
  return fetch(`${baseUrl}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
    },
    body,
  });
}

describe("webhook listener", () => {
  it("answers the subscription handshake only for the right verify token", async () => {
    const ok = await fetch(
      `${baseUrl}${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const wrong = await fetch(
      `${baseUrl}${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=other&hub.challenge=12345`,
    );
    expect(wrong.status).toBe(403);
    const noChallenge = await fetch(
      `${baseUrl}${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}`,
    );
    expect(noChallenge.status).toBe(403);
  });

  it("rejects unsigned and mis-signed bodies before parsing them", async () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    expect((await post(body)).status).toBe(401);
    expect((await post(body, signBody(Buffer.from(body), "other"))).status).toBe(401);
    expect((await post(`${body} `, signBody(Buffer.from(body), SECRET))).status).toBe(401);
    expect(received).toEqual([]);
    expect(warnings.filter((w) => /signature/.test(w))).toHaveLength(3);
  });

  it("hands a signed body to the handler and relays its verdict", async () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const ok = await post(body, signBody(Buffer.from(body), SECRET));
    expect(ok.status).toBe(200);
    expect(received).toEqual([JSON.parse(body)]);
    answer = 503;
    const retry = await post(body, signBody(Buffer.from(body), SECRET));
    expect(retry.status).toBe(503);
  });

  it("refuses oversized and non-JSON bodies, and unknown paths", async () => {
    const big = "x".repeat(300);
    expect((await post(big, signBody(Buffer.from(big), SECRET))).status).toBe(413);
    const notJson = "{not json";
    expect((await post(notJson, signBody(Buffer.from(notJson), SECRET))).status).toBe(400);
    expect((await fetch(`${baseUrl}/elsewhere`)).status).toBe(404);
    const health = await fetch(`${baseUrl}/healthz`);
    expect(await health.json()).toEqual({ ok: true });
    expect(received).toEqual([]);
  });
});
