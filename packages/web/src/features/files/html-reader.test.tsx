// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { HtmlReader } from "./html-reader.js";

afterEach(cleanup);
const html =
  '<style>h1{color:red}</style><h1>Styled report</h1><script>parent.bad=1</script><a href="https://typesafe.ai/">Primary source</a>';
function apiFor(text: string): ApiClient {
  const bytes = new TextEncoder().encode(text);
  return {
    readWorkspaceFileRange: vi.fn(async (_w, _p, input) => {
      const part = bytes.slice(input.start, input.end + 1);
      return {
        blob: { arrayBuffer: async () => part.buffer } as Blob,
        fileSize: bytes.length,
        start: input.start,
        end: input.start + part.length - 1,
      };
    }),
  } as unknown as ApiClient;
}
it("reads authenticated ranges once, keeps source bytes, and renders the same offline preview", async () => {
  const api = apiFor(html);
  const { container } = render(
    <HtmlReader api={api} workspaceId="ws_1" path="/work/report.html" />,
  );
  const frame = await screen.findByTitle("Isolated HTML preview of /work/report.html");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("srcdoc")).toContain("h1{color:red}");
  expect(frame.getAttribute("srcdoc")).not.toContain("<script");
  const reads = vi.mocked(api.readWorkspaceFileRange).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(container.querySelector(".html-reader-source")?.textContent).toBe(html);
  expect(container.querySelector("iframe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
  expect(api.readWorkspaceFileRange).toHaveBeenCalledTimes(reads);
  fireEvent.click(screen.getByText("Sources (1)"));
  expect(screen.getByRole("link", { name: "Primary source" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
});
it("does not fetch non-HTML routes and reports file read failures", async () => {
  const api = apiFor(html);
  const first = render(<HtmlReader api={api} workspaceId="ws_1" path="/work/report.js" />);
  expect(api.readWorkspaceFileRange).not.toHaveBeenCalled();
  first.unmount();
  vi.mocked(api.readWorkspaceFileRange).mockRejectedValue(new Error("workspace stopped"));
  render(<HtmlReader api={api} workspaceId="ws_1" path="/work/report.html" />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("workspace stopped"));
});

it("retries a failed HTML read in place without downloading or changing the target", async () => {
  const api = apiFor(html);
  vi.mocked(api.readWorkspaceFileRange).mockRejectedValueOnce(new Error("temporary failure"));
  render(<HtmlReader api={api} workspaceId="ws_1" path="/work/report.html" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("temporary failure");
  expect(screen.getByRole("button", { name: "Rendered" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Source" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByTitle("Isolated HTML preview of /work/report.html"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(api.readWorkspaceFileRange).toHaveBeenCalledTimes(2);
});
