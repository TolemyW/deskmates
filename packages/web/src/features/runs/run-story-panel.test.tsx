// @vitest-environment jsdom
// T1 (in-process): the story panel reads as sentences. A thought heads its segment and opens to
// the full text; a step is a verb, its object and its timing; the open step of a live run says
// how long it has been going; a screenshot sits under the step that took it.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { runEvent } from "../../test-support/fixtures.js";
import { RunStory } from "./run-story-panel.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

afterEach(() => {
  cleanup();
});

const events = [
  runEvent(1, "thinking", { text: "First I check the queue. Then I answer." }),
  runEvent(2, "tool_call", {
    toolUseId: "tu_1",
    toolName: "Bash",
    riskLevel: "L1",
    input: { command: "ls -la /work" },
  }),
  {
    ...runEvent(3, "tool_result", { toolUseId: "tu_1", content: "ok", isError: false }),
    ts: "2026-09-21T10:00:00.250Z",
  },
  runEvent(4, "tool_call", {
    toolUseId: "tu_2",
    toolName: "mcp__browser__browser_navigate",
    riskLevel: "L0",
    input: { url: "https://ops.example.test/tickets" },
  }),
  runEvent(5, "tool_result", { toolUseId: "tu_2", content: "page", isError: false }),
  runEvent(6, "screenshot", { dataUrl: PNG, caption: "tickets" }),
  runEvent(7, "tool_call", {
    toolUseId: "tu_3",
    toolName: "Read",
    riskLevel: "L0",
    input: { file_path: "/work/notes.md" },
  }),
];

describe("RunStory", () => {
  it("renders thoughts as headings and steps as verb, object and timing", () => {
    render(
      <RunStory
        events={events}
        live={true}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "What the bot is doing" })).toBeTruthy();
    const thought = screen.getByText("“First I check the queue.”").closest("details");
    expect(thought?.open).toBe(false);
    expect(thought?.textContent).toContain("Then I answer.");

    expect(screen.getByText("Ran a command").parentElement?.textContent).toContain("ls -la /work");
    expect(screen.getByText("250 ms")).toBeTruthy();
    expect(screen.getByText("Opened a page").parentElement?.textContent).toContain(
      "ops.example.test/tickets",
    );
    // The screenshot belongs to the navigation step and opens on demand.
    const opened = screen.getByText("Opened a page").closest("li");
    expect(opened?.querySelector("img")?.getAttribute("src")).toBe(PNG);
    expect(opened?.querySelector("details")?.open).toBe(false);
    // The open call of a live run ticks.
    const reading = screen.getByText("Read a file").closest("li");
    expect(reading?.className).toContain("story-open");
    expect(reading?.textContent).toMatch(/so far/);
  });

  it("marks an unfinished call of an ended run as a warning, not as now", () => {
    render(
      <RunStory
        events={events}
        live={false}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "What the bot did" })).toBeTruthy();
    const reading = screen.getByText("Read a file").closest("li");
    expect(reading?.className).toContain("tone-warn");
    expect(reading?.textContent).not.toMatch(/so far/);
  });

  it("says so when nothing happened yet and offers earlier steps when there are some", () => {
    render(
      <RunStory
        events={[]}
        live={true}
        hasOlder={true}
        loadingOlder={false}
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load earlier steps" })).toBeTruthy();
  });
});
