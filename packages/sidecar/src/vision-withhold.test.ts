// T0, ADR-0023 amendment 2, decision 12 (issue #87): which reads produce an image, what replaces
// an image item, and that only a withholding run's system prompt changes.

import type { BotId, RunId, StartRunRequest, WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { buildContext } from "./context.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";
import {
  VISION_WITHHELD_GUIDANCE,
  imageReadNotice,
  isImagePath,
  isPdfPath,
  pdfReadNotice,
  withheldImageText,
  withholdResultImages,
  withholdToolResult,
  withholdValueImages,
  withholdingToolResults,
} from "./vision-withhold.js";

describe("isImagePath", () => {
  it.each(["/work/a.png", "/work/B.JPG", "x.jpeg", "/tmp/s.gif", "/w/p.WebP"])(
    "%s is an image",
    (path) => expect(isImagePath(path)).toBe(true),
  );
  it.each([
    "/work/a.md",
    "/work/png",
    "/work/a.png.txt",
    "/work/a.svg",
    "/work/a.pdf",
    7,
    undefined,
  ])("%s is not", (path) => expect(isImagePath(path)).toBe(false));
});

describe("notices", () => {
  it("name what was withheld and forbid describing it", () => {
    expect(imageReadNotice("/work/a.png")).toMatch(/^image_withheld: \/work\/a\.png .*cannot see/);
    expect(withheldImageText("image/jpeg")).toContain("an image (image/jpeg) was withheld");
    expect(withheldImageText(undefined)).toContain("an image was withheld");
  });

  it("replaces only image items of a tool result", () => {
    const result = {
      content: [
        { type: "text", text: "page" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
    };
    expect(withholdResultImages(result)).toEqual({
      content: [
        { type: "text", text: "page" },
        { type: "text", text: withheldImageText("image/png") },
      ],
      isError: false,
    });
    const textOnly = { content: [{ type: "text", text: "page" }] };
    expect(withholdResultImages(textOnly)).toBe(textOnly);
    expect(withholdResultImages(null)).toBeNull();
  });
});

// ADR-0023 amendment 3 (issue #87): PDF reads and images inside connector or integration values.
describe("isPdfPath and the PDF notice", () => {
  it.each(["/work/a.pdf", "/work/Report.PDF"])("%s is a PDF", (path) =>
    expect(isPdfPath(path)).toBe(true),
  );
  it.each(["/work/a.pdf.txt", "/work/pdf", "/work/a.png", 3, undefined])("%s is not", (path) =>
    expect(isPdfPath(path)).toBe(false),
  );
  it("names the file and forbids guessing", () => {
    expect(pdfReadNotice("/work/a.pdf")).toMatch(
      /^image_withheld: \/work\/a\.pdf is a PDF.*cannot see/,
    );
  });
});

function base64Of(...parts: (string | number[])[]): string {
  const bytes = parts.map((p) =>
    typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p),
  );
  return Buffer.concat([...bytes, Buffer.alloc(60, 7)]).toString("base64");
}

describe("withholdValueImages", () => {
  const png = base64Of([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = base64Of([0xff, 0xd8, 0xff, 0xe0]);
  const gif = base64Of("GIF89a");
  const webp = base64Of("RIFF", [1, 2, 3, 4], "WEBP");
  const wav = base64Of("RIFF", [1, 2, 3, 4], "WAVE");

  it("replaces data URIs, base64 images and image objects with notices", () => {
    const value = {
      id: "msg-1",
      avatar: "data:image/png;base64,iVBORw0KGgo=",
      svg: "data:image/svg+xml,%3Csvg%3E",
      files: [{ name: "a.png", content: png }, { name: "b.jpg", content: jpeg }, gif, webp],
      block: { type: "image", source: { type: "base64", media_type: "image/webp", data: "x" } },
      mcp: { type: "image", data: "AAAA" },
    };
    const { value: out, withheld } = withholdValueImages(value);
    expect(withheld).toEqual([
      "image/png",
      "image/svg+xml",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/webp",
      "image",
    ]);
    const text = JSON.stringify(out);
    expect(text).not.toContain(png);
    expect(text).not.toContain("iVBORw0KGgo");
    expect(out).toMatchObject({
      id: "msg-1",
      avatar: withheldImageText("image/png"),
      mcp: withheldImageText(undefined),
    });
    expect((out as typeof value).files[0]).toEqual({
      name: "a.png",
      content: withheldImageText("image/png"),
    });
    expect(value.files[0]).toEqual({ name: "a.png", content: png });
  });

  it("leaves links, short base64, other base64 bytes and plain text alone, by reference", () => {
    const value = {
      link: "https://cdn.example.test/a.png",
      token: "iVBORw0KGgo",
      audio: wav,
      text: "the quick brown fox",
      n: 3,
      nested: [{ ok: true }, null],
    };
    const { value: out, withheld } = withholdValueImages(value);
    expect(withheld).toEqual([]);
    expect(out).toBe(value);
  });
});

describe("withholdToolResult", () => {
  it("reports the media type of each replaced item", () => {
    const { result, withheld } = withholdToolResult({
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "AAAA" },
        { type: "text", text: "x" },
      ],
    });
    expect(withheld).toEqual(["image/png", "image"]);
    expect(JSON.stringify(result)).not.toContain("AAAA");
  });
});

describe("withholdingToolResults", () => {
  const imageTool = {
    name: "some_tool",
    handler: async () => ({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
  };

  it("strips image items from every deskmates tool result and records it on a withholding run", async () => {
    const events: { kind: string; payload: Record<string, unknown> }[] = [];
    const sink = {
      emit: (kind: string, payload: Record<string, unknown>) => events.push({ kind, payload }),
    };
    const [wrapped] = withholdingToolResults(
      { visionPolicy: "withhold" },
      sink as unknown as Parameters<typeof withholdingToolResults>[1],
      [imageTool],
    );
    const result = await (wrapped?.handler as () => Promise<unknown>)();
    expect(JSON.stringify(result)).not.toContain("AAAA");
    expect(events).toEqual([
      {
        kind: "log",
        payload: {
          source: "vision",
          op: "image_withheld",
          toolName: "mcp__deskmates__some_tool",
          count: 1,
          media: ["image/png"],
        },
      },
    ]);
  });

  it("returns the very same tools on a delivering run", () => {
    const tools = [imageTool];
    const sink = { emit: () => {} };
    expect(
      withholdingToolResults(
        {},
        sink as unknown as Parameters<typeof withholdingToolResults>[1],
        tools,
      ),
    ).toBe(tools);
  });
});

describe("the system prompt", () => {
  const base: StartRunRequest = {
    runId: "run-1" as RunId,
    botId: "bot-1" as BotId,
    botName: "nova",
    workspaceId: "ws-1" as WorkspaceId,
    botHomeDir: "/home/nova",
    attempt: 1,
    trigger: { kind: "cron", prompt: "Check the deck" },
    model: "m",
    cheapModel: "c",
    modelBaseUrl: "http://gw/model",
    modelAuthToken: "t",
    gatewayBaseUrl: "http://gw",
    shortWaitSeconds: 60,
    maxTurns: 10,
    egressAllowlist: [],
    connectors: [],
    tools: [],
  };
  const now = new Date("2026-10-14T10:00:00Z");

  it("gains the Images section only when the run withholds", async () => {
    const fs = createMemoryFs({ "/home/nova/SOUL.md": "You are Nova." });
    const delivering = await buildContext(base, fs, now);
    const withholding = await buildContext({ ...base, visionPolicy: "withhold" }, fs, now);
    expect(delivering.systemPrompt).not.toContain("## Images");
    expect(withholding.systemPrompt).toBe(
      `${delivering.systemPrompt}\n\n${VISION_WITHHELD_GUIDANCE}`,
    );
  });
});
