// T2 diagnostic: both the default PNG and explicit JPEG MCP screenshot results must reach the
// next upstream model request as image blocks. The ledger omits image bytes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { postMessage, runEvents, toolCalls, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const TOKEN = "m2-vision-transport-scripted-token";

function visit(value: unknown, fn: (item: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, fn);
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  fn(item);
  for (const child of Object.values(item)) visit(child, fn);
}

function usedToolCount(messages: unknown, name: string): number {
  let found = 0;
  visit(messages, (item) => {
    if (item.type === "tool_use" && item.name === name) found += 1;
  });
  return found;
}

interface ImageMetadata {
  mediaType: string;
  bytes: number;
  signatureValid: boolean;
}

function imageMetadata(messages: unknown): ImageMetadata[] {
  const images: ImageMetadata[] = [];
  visit(messages, (item) => {
    if (item.type !== "image") return;
    const source = item.source;
    if (!source || typeof source !== "object") return;
    const image = source as Record<string, unknown>;
    if (image.type !== "base64" || typeof image.data !== "string") return;
    const bytes = Buffer.from(image.data, "base64");
    const mediaType = typeof image.media_type === "string" ? image.media_type : "";
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    const signatureValid =
      mediaType === "image/png"
        ? pngSignature.every((byte, index) => bytes[index] === byte)
        : mediaType === "image/jpeg" &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8 &&
          bytes.at(-2) === 0xff &&
          bytes.at(-1) === 0xd9;
    images.push({ mediaType, bytes: bytes.length, signatureValid });
  });
  return images;
}

interface ImageProof extends ImageMetadata {
  toolUseId: string;
  requestIndex: number;
}

/** Each tool result is recorded only at its first upstream request, not again from history. */
function imageProofs(requests: FakeModelUpstream["requests"]): ImageProof[] {
  const first = new Map<string, ImageProof>();
  requests
    .filter((request) => request.url.split("?")[0] === "/v1/messages")
    .forEach((request, requestIndex) => {
      visit(request.body?.messages, (item) => {
        if (item.type !== "tool_result" || typeof item.tool_use_id !== "string") return;
        if (first.has(item.tool_use_id)) return;
        const images = imageMetadata(item.content);
        if (images.length !== 1) return;
        const image = images[0];
        if (image)
          first.set(item.tool_use_id, { toolUseId: item.tool_use_id, requestIndex, ...image });
      });
    });
  return [...first.values()].sort((a, b) => a.requestIndex - b.requestIndex);
}

describe.skipIf(!available)(
  "M2 screenshot transport (real MCP/SDK/Gateway, scripted upstream)",
  () => {
    let stack: Stack | undefined;
    let upstream: FakeModelUpstream | undefined;
    const screenshotTurns: number[] = [];

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({
        expectedToken: TOKEN,
        reply: "transport complete",
        script: (turn, body) => {
          const tools = JSON.stringify(body?.tools ?? []);
          if (!tools.includes("mcp__browser__browser_navigate")) {
            return { kind: "text", text: assistantText("transport complete") };
          }
          if (usedToolCount(body?.messages, "mcp__browser__browser_navigate") === 0) {
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_navigate",
              input: { url: `${stack?.siteOriginForBot}/login` },
            };
          }
          if (usedToolCount(body?.messages, "mcp__browser__browser_take_screenshot") === 0) {
            screenshotTurns.push(turn);
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_take_screenshot",
              input: { scale: "css" },
            };
          }
          if (usedToolCount(body?.messages, "mcp__browser__browser_take_screenshot") === 1) {
            screenshotTurns.push(turn);
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_take_screenshot",
              input: { type: "jpeg" },
            };
          }
          return { kind: "text", text: assistantText("transport complete") };
        },
      });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: TOKEN,
        defaultModel: "fake-vision-transport-model",
        cheapModel: "fake-vision-transport-cheap",
        label: "m2-vision-transport",
      });
      stack.config.maxTurns = 5;
      stack.config.runTimeoutSeconds = 120;
    }, 120_000);

    afterAll(async () => {
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    it("forwards each default PNG and explicit JPEG result in the next upstream request", async () => {
      if (!stack || !upstream) throw new Error("transport stack was not started");
      const { run: started } = await postMessage(stack, "Inspect the login page screenshot.");
      const run = await waitForRun(stack, started.id, 150_000);
      const events = await runEvents(stack, started.id);
      const screenshotCalls = toolCalls(events, "browser_take_screenshot");
      const proofs = imageProofs(upstream.requests);
      const metadata = {
        runStatus: run.status,
        screenshotCalls: screenshotCalls.length,
        imageRequestCount: proofs.length,
        images: proofs.map(({ mediaType, bytes, signatureValid, requestIndex }) => ({
          mediaType,
          bytes,
          signatureValid,
          requestIndex,
        })),
      };
      console.log(`[m2-vision-transport] ${JSON.stringify(metadata)}`);
      expect(run.status).toBe("succeeded");
      expect(screenshotCalls).toHaveLength(2);
      for (const call of screenshotCalls) {
        expect(
          events.some(
            (event) =>
              event.kind === "tool_result" &&
              event.payload.toolUseId === call.payload.toolUseId &&
              event.payload.isError !== true,
          ),
        ).toBe(true);
      }
      expect(screenshotCalls.map((call) => call.payload.input)).toEqual([
        { scale: "css" },
        { type: "jpeg" },
      ]);
      expect(
        proofs.map(({ mediaType, signatureValid }) => ({ mediaType, signatureValid })),
      ).toEqual([
        { mediaType: "image/png", signatureValid: true },
        { mediaType: "image/jpeg", signatureValid: true },
      ]);
      expect(proofs.every((proof) => proof.bytes > 100)).toBe(true);
      expect(proofs.map((proof) => proof.toolUseId)).toEqual(
        screenshotCalls.map((call) => call.payload.toolUseId),
      );
      // Fake upstream emits toolu_fake_N while answering request N (one-based). The matching
      // image result must appear in request N+1, at zero-based index N, not a later replay.
      expect(proofs.map((proof) => proof.requestIndex)).toEqual(screenshotTurns);
    }, 180_000);
  },
);
