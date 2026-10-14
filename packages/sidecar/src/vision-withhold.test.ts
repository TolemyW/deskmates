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
  withheldImageText,
  withholdResultImages,
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
