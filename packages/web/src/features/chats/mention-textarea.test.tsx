// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { BotId, GroupRouting } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionTextarea } from "./mention-textarea.js";

afterEach(cleanup);

const members = [
  { botId: "b1" as BotId, name: "team_chief" },
  { botId: "b2" as BotId, name: "databricks_fan" },
  { botId: "b3" as BotId, name: "snowflake_fan" },
];

interface Routing {
  groupRouting?: GroupRouting;
  ownerBotId?: BotId;
  members?: readonly { botId: BotId; name: string }[];
}

function Harness({ onSubmit, routing }: { onSubmit: () => void; routing: Routing }) {
  const [value, setValue] = useState("");
  return (
    <MentionTextarea
      aria-label="Message"
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      members={routing.members ?? members}
      groupRouting={routing.groupRouting}
      ownerBotId={routing.ownerBotId}
    />
  );
}

function setup(routing: Routing = {}) {
  const onSubmit = vi.fn();
  render(<Harness onSubmit={onSubmit} routing={routing} />);
  const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(box, { target: { value } });
  const options = () => screen.queryAllByRole("option").map((o) => o.textContent);
  return { onSubmit, box, type, options };
}

describe("MentionTextarea", () => {
  it("lists members and everyone after @, filtered by what follows", () => {
    const { type, options } = setup();
    type("请 @");
    expect(options()).toEqual(["@team_chief", "@databricks_fan", "@snowflake_fan", "@everyone"]);
    type("请 @s");
    expect(options()).toEqual(["@snowflake_fan"]);
    type("请 @s ");
    expect(options()).toEqual([]);
  });

  it("Enter picks the highlighted name with a trailing space and does not send", () => {
    const { box, type, onSubmit, options } = setup();
    type("@da");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@databricks_fan ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(options()).toEqual([]);
  });

  it("the arrow keys move the highlight and Tab picks", () => {
    const { box, type } = setup();
    type("@");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("@snowflake_fan ");
  });

  it("a click picks without leaving the textarea", () => {
    const { box, type } = setup();
    type("看这里 @t");
    fireEvent.mouseDown(screen.getByRole("option", { name: "@team_chief" }));
    expect(box.value).toBe("看这里 @team_chief ");
  });

  it("Escape closes the list; Enter then sends", () => {
    const { box, type, onSubmit, options } = setup();
    type("@te");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(options()).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Enter sends when no list is open, Shift+Enter does not", () => {
    const { box, type, onSubmit } = setup();
    type("你好");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("an IME composition's Enter neither picks nor sends", () => {
    const { box, type, onSubmit } = setup();
    type("@te");
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(box.value).toBe("@te");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("previews who the message wakes, and flags names that are not members", () => {
    const { type } = setup();
    type("@team_chief 和 @databricks_fan 看看");
    expect(screen.getByText("Wakes @team_chief, @databricks_fan")).toBeInTheDocument();
    type("@team_cheif 看看");
    expect(screen.getByText("No @mention: every member is woken in turn")).toBeInTheDocument();
    expect(screen.getByText(/Unknown recipient: @team_cheif/)).toBeInTheDocument();
    type("@everyone 开会");
    expect(screen.getByText("Wakes every member, in turn (@everyone)")).toBeInTheDocument();
  });

  it("under owner-v1 an unaddressed message is offered to the owner first", () => {
    const { type } = setup({ groupRouting: "owner-v1", ownerBotId: "b2" as BotId });
    type("看看这个");
    expect(
      screen.getByText(
        "No @mention: offered to @databricks_fan first, then to the other members until one replies",
      ),
    ).toBeInTheDocument();
    type("@team_cheif 看看");
    expect(screen.getByText(/Unknown recipient: @team_cheif/).textContent).toBe(
      " · Unknown recipient: @team_cheif. With no valid mention, it is offered to @databricks_fan first, then to the other members until one replies.",
    );
    // Explicit mentions and @everyone read as they always did.
    type("@team_chief 看看");
    expect(screen.getByText("Wakes @team_chief")).toBeInTheDocument();
    type("@everyone 开会");
    expect(screen.getByText("Wakes every member, in turn (@everyone)")).toBeInTheDocument();
  });

  it("under owner-v1 with no owner an unaddressed message is offered one member at a time", () => {
    const { type } = setup({ groupRouting: "owner-v1" });
    type("看看这个");
    expect(
      screen.getByText("No @mention: offered to one member at a time until one replies"),
    ).toBeInTheDocument();
    type("@nobody 看看");
    expect(screen.getByText(/Unknown recipient: @nobody/).textContent).toContain(
      ". With no valid mention, it is offered to one member at a time until one replies.",
    );
  });

  it("walk-v1, a missing routing and a one-member thread keep the walk wording", () => {
    for (const routing of [
      { groupRouting: "walk-v1", ownerBotId: "b2" as BotId },
      { ownerBotId: "b2" as BotId },
      { groupRouting: "owner-v1", ownerBotId: "b1" as BotId, members: members.slice(0, 1) },
    ] satisfies Routing[]) {
      const { type } = setup(routing);
      type("@nobody 看看");
      expect(screen.getByText("No @mention: every member is woken in turn")).toBeInTheDocument();
      expect(screen.getByText(/Unknown recipient: @nobody/).textContent).toContain(
        ". With no valid mention, every member is woken in turn.",
      );
      cleanup();
    }
  });

  it("keeps the routing hint in the footer slot that holds the actions, empty or not (#111)", () => {
    function WithFooter() {
      const [value, setValue] = useState("");
      return (
        <MentionTextarea
          aria-label="Message"
          value={value}
          onChange={setValue}
          onSubmit={() => {}}
          members={members}
          footer={<button type="submit">Send</button>}
        />
      );
    }
    const { container } = render(<WithFooter />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    const footer = container.querySelector(".composer-footer");
    const slot = container.querySelector(".mention-preview-slot");
    // The slot sits beside the actions before anything is typed, so showing the hint adds no row.
    expect(footer).not.toBeNull();
    expect(slot?.parentElement).toBe(footer);
    expect(footer?.querySelector("button")?.textContent).toBe("Send");
    expect(slot?.textContent).toBe("");

    fireEvent.change(box, { target: { value: "h" } });
    expect(container.querySelector(".mention-preview-slot")).toBe(slot);
    expect(container.querySelector(".composer-footer")).toBe(footer);
    expect(slot?.textContent).toBe("No @mention: every member is woken in turn");
    expect(container.querySelectorAll(".mention-preview")).toHaveLength(1);

    fireEvent.change(box, { target: { value: "" } });
    expect(container.querySelector(".mention-preview-slot")).toBe(slot);
    expect(slot?.textContent).toBe("");
  });
});
