// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, looksLikeMarkdown } from "./markdown.js";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders block structure without ever producing raw HTML", () => {
    const { container } = render(
      <Markdown
        text={
          "# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted\n\n```sh\nnpm test\n```\n\n<script>alert(1)</script>"
        }
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelectorAll("ul > li")).toHaveLength(3);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(container.querySelector("pre code")?.textContent).toBe("npm test");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("links only http(s) targets, in a new tab without a referrer", () => {
    render(
      <Markdown
        text={
          "See [docs](https://example.com/a) and [bad](javascript:alert(1)) or https://x.test/p?q=1."
        }
      />,
    );
    const good = screen.getByRole("link", { name: "docs" });
    expect(good.getAttribute("href")).toBe("https://example.com/a");
    expect(good.getAttribute("target")).toBe("_blank");
    expect(good.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByRole("link", { name: "https://x.test/p?q=1" })).toBeTruthy();
  });

  it("marks mentions and hands plain text runs to the caller", () => {
    const seen: string[] = [];
    const { container } = render(
      <Markdown
        text="@chief wrote /work/brief.md today"
        renderText={(text, key) => {
          seen.push(text);
          return <span key={key}>{text}</span>;
        }}
      />,
    );
    expect(container.querySelector(".mention")?.textContent).toBe("@chief");
    expect(seen.join("|")).toBe(" wrote /work/brief.md today");
  });

  it("keeps single newlines inside a paragraph as line breaks", () => {
    const { container } = render(<Markdown text={"line one\nline two"} />);
    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(container.querySelectorAll(".para")).toHaveLength(1);
  });

  it("joins wrapped source lines into one paragraph with soft breaks, as documents expect", () => {
    const { container } = render(
      <Markdown
        text={"line one\nline two\n\n> quote one\n> quote two"}
        options={{ softBreaks: true }}
      />,
    );
    expect(container.querySelectorAll("br")).toHaveLength(0);
    expect(container.querySelector(".para")?.textContent).toBe("line one line two");
    expect(container.querySelector("blockquote")?.textContent).toBe("quote one quote two");
  });

  it("renders a pipe table", () => {
    const { container } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("detects markdown-ish text", () => {
    expect(looksLikeMarkdown("plain words here")).toBe(false);
    expect(looksLikeMarkdown("- item")).toBe(true);
    expect(looksLikeMarkdown("use `x`")).toBe(true);
  });
});
