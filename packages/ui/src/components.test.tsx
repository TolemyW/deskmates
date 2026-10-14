// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ButtonLink, Input, TextArea } from "./index.js";

afterEach(cleanup);

describe("owned interaction contracts", () => {
  it("preserves consumer-owned tab roles and selection state", () => {
    const select = vi.fn();
    render(
      <Button role="tab" aria-selected={true} onClick={select}>
        Workspace
      </Button>,
    );
    const tab = screen.getByRole("tab", { name: "Workspace" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab);
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("submits only explicit submit buttons and preserves named form values", () => {
    const submit = vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault());
    const clicked = vi.fn();
    render(
      <form onSubmit={submit}>
        <Button onClick={clicked}>Inspect</Button>
        <Input aria-label="Title" name="title" defaultValue="Research" />
        <Button type="submit" name="action" value="save">
          Save
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).toHaveBeenCalledTimes(1);
    const form = screen.getByRole("textbox").closest("form");
    expect(form).not.toBeNull();
    expect(new FormData(form as HTMLFormElement).get("title")).toBe("Research");
  });

  it("blocks disabled and pending actions, then allows the ready action once", () => {
    const action = vi.fn();
    const { rerender } = render(
      <Button disabled onClick={action}>
        Allow once
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    rerender(
      <Button loading onClick={action}>
        Allow once
      </Button>,
    );
    expect(screen.getByRole("button").getAttribute("data-pending")).toBe("true");
    fireEvent.click(screen.getByRole("button"));
    expect(action).not.toHaveBeenCalled();
    rerender(<Button onClick={action}>Allow once</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("keeps links as anchors with their destination and target", () => {
    render(
      <ButtonLink href="#/contacts" target="_blank" rel="noopener">
        Contacts
      </ButtonLink>,
    );
    const link = screen.getByRole("link", { name: "Contacts" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("#/contacts");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("forwards field refs, labels, validation, changes and readonly state", () => {
    const input = createRef<HTMLInputElement>();
    const change = vi.fn();
    render(
      <>
        <label htmlFor="title">Title</label>
        <Input
          id="title"
          ref={input}
          required
          aria-invalid="true"
          aria-describedby="error"
          onChange={change}
        />
        <p id="error">Title required</p>
        <TextArea aria-label="Context" readOnly defaultValue="Keep this draft" />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Title" });
    expect(input.current).toBe(field);
    expect(input.current?.required).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe("error");
    fireEvent.change(field, { target: { value: "New title" } });
    expect(change).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "Context" }) as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
  });
});
