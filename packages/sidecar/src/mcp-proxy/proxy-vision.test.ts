// T1, ADR-0023 amendment 2, decision 12c (issue #87): on a run whose model cannot see, the browser
// proxy hands the SDK a text notice wherever the MCP server returned an image, on both the plain
// and the coordinated path, and the opt-in vision fallback attaches nothing. In-memory streams; the
// test answers JSON-RPC as `@playwright/mcp` 0.0.82 would.

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type McpProxyOptions, SCREENSHOT_TOOL, runMcpProxy } from "./proxy.js";

const JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==";

function startProxy(options: McpProxyOptions) {
  const upstreamIn = new PassThrough();
  const upstreamOut = new PassThrough();
  const childIn = new PassThrough();
  const childOut = new PassThrough();
  const toChild: string[] = [];
  const toUpstream: string[] = [];
  createInterface({ input: childIn }).on("line", (line) => toChild.push(line));
  createInterface({ input: upstreamOut }).on("line", (line) => toUpstream.push(line));
  const done = runMcpProxy({
    upstream: { input: upstreamIn, output: upstreamOut },
    child: { stdin: childIn, stdout: childOut },
    options: { log: () => {}, ...options },
  });
  return {
    toChild,
    toUpstream,
    sdk: (m: unknown) => upstreamIn.write(`${JSON.stringify(m)}\n`),
    server: (m: unknown) => childOut.write(`${JSON.stringify(m)}\n`),
    end: async () => {
      upstreamIn.end();
      childOut.end();
      await done;
    },
  };
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const screenshotResult = (id: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [
      { type: "text", text: "### Result\n- [Screenshot](./page-1.jpeg)" },
      { type: "image", data: JPEG, mimeType: "image/jpeg" },
    ],
  },
});

function content(line: string | undefined): { type: string; text?: string; data?: string }[] {
  return (JSON.parse(line ?? "{}") as { result?: { content?: [] } }).result?.content ?? [];
}

describe("withheld images in browser results", () => {
  it("replaces a screenshot's image item with a host notice, outside the page wrapper", async () => {
    const w = startProxy({ withholdImages: true });
    w.sdk(call(1, SCREENSHOT_TOOL));
    w.server(screenshotResult(1));
    await expect.poll(() => w.toUpstream.length).toBe(1);
    const items = content(w.toUpstream[0]);
    expect(items.some((item) => item.type === "image")).toBe(false);
    expect(items[1]).toEqual({
      type: "text",
      text: expect.stringContaining("an image (image/jpeg) was withheld"),
    });
    expect(items[1]?.text).not.toContain("<untrusted");
    expect(w.toUpstream[0]).not.toContain(JPEG);
    await w.end();
  });

  it("does the same on the coordinated path", async () => {
    const w = startProxy({
      withholdImages: true,
      coordination: {
        before: async (browserCall) => browserCall,
        after: async () => {},
        canCapture: async () => true,
        tabId: () => "tab",
        epoch: () => 0,
      },
    });
    w.sdk(call(1, SCREENSHOT_TOOL));
    await expect.poll(() => w.toChild.length).toBe(1);
    w.server(screenshotResult(JSON.parse(w.toChild[0] as string).id));
    await expect.poll(() => w.toUpstream.length).toBe(1);
    expect(content(w.toUpstream[0]).map((item) => item.type)).toEqual(["text", "text"]);
    expect(w.toUpstream[0]).not.toContain(JPEG);
    await w.end();
  });

  it("leaves images in place when the run delivers them", async () => {
    const w = startProxy({});
    w.sdk(call(1, SCREENSHOT_TOOL));
    w.server(screenshotResult(1));
    await expect.poll(() => w.toUpstream.length).toBe(1);
    expect(content(w.toUpstream[0])[1]).toMatchObject({ type: "image", data: JPEG });
    await w.end();
  });

  it("never takes a vision-fallback screenshot, even when the strategy is opted in", async () => {
    const w = startProxy({ withholdImages: true, visionFallback: true });
    for (const id of [1, 2]) {
      w.sdk(call(id, "browser_click", { target: "e3" }));
      w.server({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Ref e3 not found in the current page snapshot." }],
        },
      });
      await expect.poll(() => w.toUpstream.length).toBe(id);
    }
    expect(w.toChild.some((line) => line.includes(SCREENSHOT_TOOL))).toBe(false);
    await w.end();
  });
});
